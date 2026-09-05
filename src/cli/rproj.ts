#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

// rproj — Unified Remote Project Tool
//
// Browse and open projects across multiple remote SSH hosts.
// Supports interactive selection via fzf and direct commands.
//
// Subcommands:
//   list (l)   — List remote projects (text or Alfred JSON)
//   tmux (t)   — Open tmux session for a project
//   code (c)   — Open VS Code for a project
//   finder (f) — Open project in Finder via SSHFS
//   setup      — Print recommended SSH config
//   open (o)   — Open from Alfred (host|path format)
//   help       — Show this help

import { blue, green, red, yellow } from "jsr:@std/fmt@1/colors";
import { basename } from "jsr:@std/path@1/basename";
import {
  buildFzfEntries,
  type HostEntry,
  isAbsoluteProjectPath,
  type Opts,
  parseArgs,
  type ProjectEntry,
  type ProjectMatch,
  shellQuote,
  TERMINAL_RESTORE_SEQUENCE,
} from "../lib/rproj_utils.ts";
import { SOCK } from "../lib/oa.ts";
import type { Message, Response } from "../lib/messages.ts";
import { type CliDeps, realDeps } from "./deps.ts";

// --- Constants ---

const SCRIPT_NAME = "rproj";
const SSH_TIMEOUT_MS = 5_000;

/**
 * Conventional project roots probed on an unconfigured host. The first one
 * that exists becomes the base dir for discovery; the rest are ignored.
 * `$HOME` is resolved remotely so `~/src` works regardless of the local
 * username.
 */
const DEFAULT_PROJECT_ROOTS = ["~/src", "~/code", "~/projects", "~/dev"];

// Effects and config paths are set in main() from the injected deps, so the
// module is importable without executing anything at import time.
let deps: CliDeps = realDeps;
let OA_CONFIG_DIR = "";
let LEGACY_CONFIG_DIR = "";

// --- Logging (suppressed in JSON mode) ---

let jsonMode = false;
let debugMode = false;

function info(msg: string): void {
  if (!jsonMode) console.error(blue(msg));
}
function success(msg: string): void {
  if (!jsonMode) console.error(green(msg));
}
function warn(msg: string): void {
  if (!jsonMode) console.error(yellow(msg));
}
function debug(msg: string): void {
  if (debugMode) console.error(yellow(`[debug] ${msg}`));
}

function error(msg: string): never {
  if (jsonMode) {
    console.log(JSON.stringify({
      items: [{
        title: "Error",
        subtitle: msg,
        valid: false,
        icon: { path: "error.png" },
      }],
    }));
    deps.exit(0);
  }
  console.error(red(`Error: ${msg}`));
  deps.exit(1);
}

// Run a child that takes over the TTY (e.g. ssh into a tmux session) and
// guarantee terminal cleanup even if the child dies abruptly — for example
// when the SSH connection is killed by a network drop and remote tmux never
// gets to emit its terminal-restore sequences. Without this, the local
// terminal is left in alt-screen + raw mode and the user has to run `reset`.
async function execWithTtyRestore(
  cmd: string,
  args: string[],
): Promise<number> {
  const isTty = deps.stdin.isTerminal();

  let savedStty: string | null = null;
  if (isTty) {
    const r = await deps.run("stty", ["-g"], { stdin: "inherit" });
    if (r.success) savedStty = r.stdout;
  }

  const child = new Deno.Command(cmd, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  // Forward catchable termination signals to the child so the `finally`
  // below still runs terminal cleanup. SIGINT is intentionally omitted:
  // while ssh holds the PTY in raw mode, Ctrl-C is delivered as a byte
  // to ssh, not as a signal to us. SIGKILL can't be caught.
  const forwarded: Deno.Signal[] = ["SIGTERM", "SIGHUP"];
  const signalHandlers = forwarded.map((sig) => {
    const fn = () => {
      try {
        child.kill(sig);
      } catch { /* already exited */ }
    };
    Deno.addSignalListener(sig, fn);
    return { sig, fn };
  });

  try {
    const { code } = await child.status;
    return code;
  } finally {
    for (const { sig, fn } of signalHandlers) {
      Deno.removeSignalListener(sig, fn);
    }
    if (isTty) {
      // Send the cleanup to /dev/tty (the controlling terminal) directly
      // when we can: this bypasses any stdout indirection from the
      // rtmux→rproj wrapper chain and reaches the user's actual terminal
      // even when fd 1 is something else (e.g. a pipe to a logger). Fall
      // back to stdout when /dev/tty isn't openable (no controlling tty).
      const bytes = new TextEncoder().encode(TERMINAL_RESTORE_SEQUENCE);
      let wroteToTty = false;
      try {
        using tty = await Deno.open("/dev/tty", { write: true, read: false });
        await tty.write(bytes);
        wroteToTty = true;
      } catch { /* no controlling tty — fall through to stdout */ }
      if (!wroteToTty) {
        try {
          await deps.stdout.write(bytes);
        } catch { /* terminal already closed */ }
      }
      await deps.run("stty", [savedStty ?? "sane"], { stdin: "inherit" });
    }
  }
}

/**
 * Talk to the daemon through the shared client in `lib/oa.ts`.
 *
 * rproj used to hand-roll this: its own `Deno.connect`, its own framing, and
 * a single fixed-size read that would truncate a reply arriving in more than
 * one piece. It was the last of three separate transport implementations.
 * Going through `send()` picks up the newline framing, the structured error
 * shape, and the connect timeout for free.
 *
 * `mountTimeoutSec` exists because an `open` may have to bring up an sshfs
 * mount first, which is far slower than the default request.
 */
async function agentSend(
  message: Message,
  timeoutSec?: number,
): Promise<Response> {
  try {
    return await deps.send(message, timeoutSec);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${detail}\n  Is open-agent running? Check: launchctl list | grep open-agent`,
    );
  }
}

/** Generous enough for a cold sshfs mount on a sleepy host. */
const MOUNT_TIMEOUT_SEC = 30;

// --- Config ---

function resolveHostsFile(): { path: string; isLegacy: boolean } {
  const canonical = `${OA_CONFIG_DIR}/remote-hosts`;
  if (deps.existsSync(canonical)) return { path: canonical, isLegacy: false };

  const legacy = `${LEGACY_CONFIG_DIR}/hosts`;
  if (deps.existsSync(legacy)) {
    warn(`Using legacy config at ${legacy} — move to ${canonical}`);
    return { path: legacy, isLegacy: true };
  }

  return { path: canonical, isLegacy: false };
}

async function loadHosts(hostFilter: string | null): Promise<HostEntry[]> {
  const { path: hostsPath } = resolveHostsFile();

  let hosts: HostEntry[] = [];

  if (deps.existsSync(hostsPath)) {
    const text = deps.readTextFileSync(hostsPath);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [alias, dir, label] = trimmed.split("|").map((s) => s.trim());
      if (!alias || !dir) continue;
      hosts.push({ alias, dir, label: label || alias });
    }
  } else {
    // Try legacy single-host config
    const legacyConfig = `${LEGACY_CONFIG_DIR}/config`;
    if (deps.existsSync(legacyConfig)) {
      const text = deps.readTextFileSync(legacyConfig);
      let host = "workmbp";
      let dir = "";
      for (const line of text.split("\n")) {
        const match = line.match(/^(\w+)="?([^"]*)"?/);
        if (match) {
          if (match[1] === "RPROJ_HOST") host = match[2];
          if (match[1] === "RPROJ_DIR") dir = match[2];
        }
      }
      if (dir) hosts.push({ alias: host, dir, label: host });
    }
  }

  if (hosts.length === 0) {
    error(
      `No hosts file found. Create ${OA_CONFIG_DIR}/remote-hosts with format: host|dir|label`,
    );
  }

  debug(
    `Loaded ${hosts.length} host entries: ${
      hosts.map((h) => `${h.alias} (${h.dir})`).join(", ")
    }`,
  );

  if (hostFilter) {
    hosts = hosts.filter((h) => h.alias === hostFilter);
    if (hosts.length === 0) {
      // The host is not configured. Synthesize an entry by probing the
      // remote for conventional project roots — this is what makes
      // `rproj tmux somehost:proj` work against arbitrary hosts.
      hosts = [await synthesizeHost(hostFilter)];
    }
    debug(`Filtered to host '${hostFilter}': ${hosts.length} entries`);
  }

  return hosts;
}

/**
 * Build a HostEntry for a host that is not in the config file, by probing
 * conventional project roots on the remote. The first root that exists
 * becomes the base dir; the rest are ignored.
 *
 * This is deliberately a probe, not a guess: an unreachable host or one with
 * none of the conventional roots fails with a clear message instead of
 * silently producing an empty project list.
 */
async function synthesizeHost(host: string): Promise<HostEntry> {
  debug(`Host '${host}' not in config — probing remote for project roots`);
  // Resolve the remote home first: `~/` cannot be quoted in an SSH command
  // (the remote shell would not expand it), and every downstream probe and
  // discovery command quotes paths. Absolute paths work everywhere.
  const home = await sshGetHome(host);
  for (const root of DEFAULT_PROJECT_ROOTS) {
    const abs = root.startsWith("~/") ? `${home}/${root.slice(2)}` : root;
    if (await sshTestPath(host, abs)) {
      debug(`Found project root ${abs} on ${host}`);
      return { alias: host, dir: abs, label: host };
    }
  }
  error(
    `Host '${host}' is not in ${OA_CONFIG_DIR}/remote-hosts and no ` +
      `conventional project root (${DEFAULT_PROJECT_ROOTS.join(", ")}) was ` +
      `found on it. Add it to the hosts file, or use 'host:/abs/path' to ` +
      `open a specific directory.`,
  );
}

/**
 * Ensure the remote has the open-agent client toolkit, offering to deploy
 * it when missing. Returns true when the toolkit is present (or was just
 * deployed); false when the user declined.
 *
 * The deploy reuses `open-agent setup-remote <host>` — the same additive
 * overlay that ships the r* wrappers and the shell hook. It never removes
 * anything on the remote. After the deploy, the identity file is written
 * and the hook is wired into the remote's rc file, so the next SSH session
 * registers with the daemon automatically.
 */
async function ensureRemoteToolkit(host: string): Promise<boolean> {
  if (await sshHasToolkit(host)) return true;

  warn(
    `open-agent is not installed on '${host}' (no ~/.local/bin/ropen).`,
  );
  const choice = await fzfSelectSimple(
    ["yes", "no"],
    {
      prompt: "Deploy open-agent to this host? ",
      header: `Deploy the r* client toolkit to ${host}?`,
      height: "20%",
    },
  );
  if (choice !== "yes") {
    info("Skipping deploy — continuing without the remote toolkit.");
    return false;
  }

  info(`Deploying open-agent to ${host}...`);
  const code = await deps.exec("open-agent", ["setup-remote", host]);
  if (code !== 0) {
    error(`Deploy to ${host} failed (exit ${code}).`);
  }

  // Identity: the daemon keys mounts by the SSH Host alias, so the remote
  // must know the name the local Mac uses for it.
  await sshWriteIdentity(host, host);

  // Hook: register sessions with the daemon on the next SSH login.
  const hook = await sshProbeHook(host);
  if (hook.rcPath && !hook.alreadySourced) {
    await sshAppendHook(host, hook.rcPath);
    info(
      `Hook added to ${hook.rcPath} on ${host} — reconnect SSH to activate.`,
    );
  } else if (hook.rcPath) {
    info(`Hook already sourced in ${hook.rcPath} on ${host}.`);
  } else {
    warn(
      `Could not detect a zsh/bash rc file on ${host} — source ` +
        `~/.local/share/open-agent/open-agent-hook.sh manually.`,
    );
  }

  success(`open-agent deployed to ${host}.`);
  return true;
}

// --- SSH helpers ---

// Common SSH options for discovery commands: bypass multiplexing so that
// ConnectTimeout is respected even when a hung ControlMaster exists.
const SSH_DISCOVERY_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=3",
  "-o",
  "ControlPath=none",
];

async function sshTestPath(host: string, path: string): Promise<boolean> {
  const result = await deps.run("ssh", [
    ...SSH_DISCOVERY_OPTS,
    host,
    `test -d ${shellQuote(path)}`,
  ], { timeout: SSH_TIMEOUT_MS });
  return result.success;
}

async function sshTestDir(host: string, path: string): Promise<boolean> {
  return sshTestPath(host, path);
}

/** True when the remote has the open-agent client toolkit installed. */
async function sshHasToolkit(host: string): Promise<boolean> {
  const result = await deps.run("ssh", [
    ...SSH_DISCOVERY_OPTS,
    host,
    "test -x ~/.local/bin/ropen",
  ], { timeout: SSH_TIMEOUT_MS });
  return result.success;
}

/**
 * Write the open-agent identity file on a remote. The value must match the
 * SSH Host alias the local Mac uses for this machine — the daemon hands it
 * straight to sshfs as an SSH destination.
 */
async function sshWriteIdentity(host: string, identity: string): Promise<void> {
  const result = await deps.run("ssh", [
    ...SSH_DISCOVERY_OPTS,
    host,
    `mkdir -p ~/.config/open-agent && printf '%s' ${
      shellQuote(identity)
    } > ~/.config/open-agent/identity`,
  ], { timeout: SSH_TIMEOUT_MS });
  if (!result.success) {
    throw new Error(`Could not write identity file on ${host}`);
  }
}

/**
 * Probe the remote's login shell rc file for the open-agent hook. Returns
 * the rc path when the hook is already sourced, otherwise the rc path to
 * append to (or null when the shell is unknown).
 */
async function sshProbeHook(host: string): Promise<{
  rcPath: string | null;
  alreadySourced: boolean;
}> {
  const result = await deps.run("ssh", [
    ...SSH_DISCOVERY_OPTS,
    host,
    'case "$SHELL" in */zsh) echo zsh;; */bash) echo bash;; *) echo other;; esac',
  ], { timeout: SSH_TIMEOUT_MS });
  const shell = result.stdout.trim();
  const rcPath = shell === "zsh"
    ? "~/.zshrc"
    : shell === "bash"
    ? "~/.bashrc"
    : null;
  if (!rcPath) return { rcPath: null, alreadySourced: false };

  const probe = await deps.run("ssh", [
    ...SSH_DISCOVERY_OPTS,
    host,
    `grep -q 'open-agent-hook.sh' ${rcPath} 2>/dev/null && echo yes || echo no`,
  ], { timeout: SSH_TIMEOUT_MS });
  return { rcPath, alreadySourced: probe.stdout.trim() === "yes" };
}

/**
 * Append the hook source line to a remote rc file. Idempotent by
 * construction — callers only invoke this after sshProbeHook reports the
 * hook is missing.
 */
async function sshAppendHook(host: string, rcPath: string): Promise<void> {
  const result = await deps.run("ssh", [
    ...SSH_DISCOVERY_OPTS,
    host,
    `printf '\\n# open-agent shell hook\\nsource ~/.local/share/open-agent/open-agent-hook.sh\\n' >> ${rcPath}`,
  ], { timeout: SSH_TIMEOUT_MS });
  if (!result.success) {
    throw new Error(`Could not append hook to ${rcPath} on ${host}`);
  }
}

async function sshListDirs(host: string, dir: string): Promise<string[]> {
  debug(`sshListDirs: ${host}:${dir}`);
  const result = await deps.run("ssh", [
    ...SSH_DISCOVERY_OPTS,
    host,
    `find ${
      shellQuote(dir)
    } -maxdepth 1 -mindepth 1 -type d -not -name '.*' | sort`,
  ], { timeout: SSH_TIMEOUT_MS });
  if (!result.success) {
    debug(
      `sshListDirs FAILED for ${host}:${dir} — code=${result.code}, stderr=${result.stderr}`,
    );
    return [];
  }
  const dirs = result.stdout.split("\n").filter(Boolean);
  debug(`sshListDirs: ${host}:${dir} → ${dirs.length} dirs found`);
  return dirs;
}

async function sshGetHome(host: string): Promise<string> {
  const result = await deps.run("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    host,
    "echo $HOME",
  ], { timeout: SSH_TIMEOUT_MS });
  if (!result.success) {
    throw new Error(`Could not determine remote home on ${host}`);
  }
  return result.stdout;
}

// --- Project Discovery ---

async function discoverProjects(hosts: HostEntry[]): Promise<ProjectEntry[]> {
  debug(`Discovering projects across ${hosts.length} host entries`);
  const results = await Promise.all(
    hosts.map(async (entry) => {
      debug(`Discovering on ${entry.alias} (${entry.label}): ${entry.dir}`);
      const dirs = await sshListDirs(entry.alias, entry.dir);
      const entries: ProjectEntry[] = [
        {
          host: entry.alias,
          baseDir: entry.dir,
          projectPath: entry.dir,
          label: entry.label,
        },
      ];
      for (const d of dirs) {
        entries.push({
          host: entry.alias,
          baseDir: entry.dir,
          projectPath: d,
          label: entry.label,
        });
      }
      debug(
        `${entry.alias} (${entry.label}): ${entries.length} entries (1 parent + ${dirs.length} children)`,
      );
      return entries;
    }),
  );
  const all = results.flat();
  debug(`Total discovered: ${all.length} project entries`);
  return all;
}

// --- fzf Integration ---

async function fzfSelect(
  input: string,
  opts: { prompt: string; header: string; preview?: string; height?: string },
): Promise<string | null> {
  const args = [
    "--height=" + (opts.height ?? "60%"),
    "--layout=reverse",
    "--border",
    "--cycle",
    "--delimiter=\t",
    "--with-nth=2",
    `--prompt=${opts.prompt}`,
    `--header=${opts.header}`,
  ];
  if (opts.preview) args.push(`--preview=${opts.preview}`);

  const result = await deps.run("fzf", args, {
    stdin: "piped",
    input: new TextEncoder().encode(input),
  });
  if (!result.success) return null;
  return result.stdout;
}

async function fzfSelectSimple(
  items: string[],
  opts: { prompt: string; header: string; height?: string },
): Promise<string | null> {
  const result = await deps.run("fzf", [
    "--height=" + (opts.height ?? "30%"),
    "--layout=reverse",
    "--border",
    "--no-preview",
    `--prompt=${opts.prompt}`,
    `--header=${opts.header}`,
  ], {
    stdin: "piped",
    input: new TextEncoder().encode(items.join("\n")),
  });
  if (!result.success) return null;
  return result.stdout;
}

async function selectProject(
  projects: ProjectEntry[],
): Promise<{ host: string; path: string }> {
  const fzfInput = buildFzfEntries(projects);
  if (!fzfInput) error("No projects found on any configured host");

  // Resolve the script path for fzf --preview
  const scriptPath = new URL(import.meta.url).pathname;

  const selected = await fzfSelect(fzfInput, {
    prompt: "Select project: ",
    header: "Select a project to open",
    preview: `'${scriptPath}' _preview_multi {1}`,
  });

  if (!selected) {
    console.log("Cancelled.");
    deps.exit(0);
  }

  const meta = selected.split("\t")[0];
  const [host, ...pathParts] = meta.split("|");
  return { host, path: pathParts.join("|") };
}

// --- Project Resolution ---

async function resolveProjectOnHost(
  hosts: HostEntry[],
  hostAlias: string,
  projectName: string,
): Promise<ProjectMatch> {
  const hostDirs = hosts.filter((h) => h.alias === hostAlias).map((h) => h.dir);
  if (hostDirs.length === 0) error(`Host ${hostAlias} not found in config`);

  // Check if project name matches a parent directory
  for (const dir of hostDirs) {
    if (projectName === basename(dir)) return { host: hostAlias, path: dir };
  }

  // Search all dirs for this host in parallel
  const probes = hostDirs.map(async (dir) => {
    const candidate = `${dir}/${projectName}`;
    return (await sshTestDir(hostAlias, candidate)) ? candidate : null;
  });
  const found = (await Promise.all(probes)).filter((p): p is string =>
    p !== null
  );

  if (found.length === 0) {
    error(`Project '${projectName}' not found on ${hostAlias}`);
  }
  if (found.length === 1) return { host: hostAlias, path: found[0] };

  // Multiple matches on same host — let user pick
  const selection = await fzfSelectSimple(found, {
    prompt: "Multiple matches: ",
    header:
      `Project '${projectName}' found in multiple directories on ${hostAlias}`,
  });
  if (!selection) {
    console.log("Cancelled.");
    deps.exit(0);
  }
  return { host: hostAlias, path: selection };
}

async function resolveProjectAcrossHosts(
  hosts: HostEntry[],
  projectName: string,
): Promise<ProjectMatch> {
  // Check parent directory basename matches first (no SSH needed)
  const parentMatches: ProjectMatch[] = [];
  const remaining: HostEntry[] = [];
  for (const entry of hosts) {
    if (basename(entry.dir) === projectName) {
      parentMatches.push({ host: entry.alias, path: entry.dir });
    } else {
      remaining.push(entry);
    }
  }

  // Probe remaining host/dir combos as subdirectories in parallel
  const probes = remaining.map(async (entry) => {
    const candidate = `${entry.dir}/${projectName}`;
    return (await sshTestDir(entry.alias, candidate))
      ? { host: entry.alias, path: candidate }
      : null;
  });
  const subMatches = (await Promise.all(probes)).filter(
    (m): m is ProjectMatch => m !== null,
  );
  const matches = [...parentMatches, ...subMatches];

  if (matches.length === 0) {
    error(`Project '${projectName}' not found on any configured host`);
  }
  if (matches.length === 1) return matches[0];

  // Multiple matches — fzf picker
  const items = matches.map((m) => `${m.host}\t${m.host}: ${m.path}`);
  const selected = await fzfSelect(items.join("\n"), {
    prompt: "Select host: ",
    header: `Project '${projectName}' found on multiple hosts`,
    height: "30%",
  });
  if (!selected) {
    console.log("Cancelled.");
    deps.exit(0);
  }
  const selectedHost = selected.split("\t")[0];
  return matches.find((m) => m.host === selectedHost)!;
}

async function getProjectSelection(
  hosts: HostEntry[],
  opts: Opts,
): Promise<ProjectMatch> {
  if (opts.projectName) {
    // Absolute paths (host:/abs/path or host:~/path) bypass config and
    // discovery entirely — they name a specific directory on a pinned host.
    if (opts.hostFilter && isAbsoluteProjectPath(opts.projectName)) {
      const host = opts.hostFilter;
      await ensureRemoteToolkit(host);
      // Expand `~/` here so every downstream consumer (ssh for tmux/code,
      // the daemon for finder) receives an absolute path — none of them
      // expand tilde themselves.
      let path = opts.projectName;
      if (path.startsWith("~/")) {
        const home = await sshGetHome(host);
        path = `${home}/${path.slice(2)}`;
      }
      info(`Using path: ${path} on ${host}`);
      return { host, path };
    }
    if (opts.hostFilter) {
      const match = await resolveProjectOnHost(
        hosts,
        opts.hostFilter,
        opts.projectName,
      );
      info(`Using project: ${opts.projectName} on ${match.host}`);
      return match;
    }
    if (hosts.length === 1 || new Set(hosts.map((h) => h.alias)).size === 1) {
      const match = await resolveProjectOnHost(
        hosts,
        hosts[0].alias,
        opts.projectName,
      );
      info(`Using project: ${opts.projectName} on ${match.host}`);
      return match;
    }
    const match = await resolveProjectAcrossHosts(hosts, opts.projectName);
    info(`Using project: ${opts.projectName} on ${match.host}`);
    return match;
  }

  info("Discovering projects...");
  const projects = await discoverProjects(hosts);
  if (projects.length === 0) error("No projects found");
  return await selectProject(projects);
}

// --- Subcommands ---

async function cmdList(
  opts: Opts,
  isJson: boolean,
  query: string,
): Promise<void> {
  const hosts = await loadHosts(opts.hostFilter);
  info("Discovering projects...");
  const projects = await discoverProjects(hosts);

  if (isJson) {
    const items = projects
      .filter((p) => {
        if (!query) return true;
        return basename(p.projectPath).toLowerCase().includes(
          query.toLowerCase(),
        );
      })
      .map((p) => {
        const name = basename(p.projectPath);
        const isParent = p.projectPath === p.baseDir;
        const displayName = isParent ? `\u{1F4C2} ${name}` : name;
        const multiHost = new Set(hosts.map((h) => h.alias)).size > 1;
        const subtitle = multiHost
          ? `[${p.label}] Open in VS Code: ${p.projectPath}`
          : `Open in VS Code: ${p.projectPath}`;
        return {
          uid: `${p.host}_${name}`,
          title: displayName,
          subtitle,
          arg: `${p.host}|${p.projectPath}`,
          autocomplete: name,
          icon: { path: "vscode.png" },
        };
      });
    console.log(JSON.stringify({ items }, null, 2));
    return;
  }

  if (projects.length === 0) {
    warn("No projects found on any configured host");
    return;
  }

  let currentLabel = "";
  for (const p of projects) {
    if (p.label !== currentLabel) {
      if (currentLabel) console.log();
      console.log(green(`${p.label}`) + ` (${p.host})`);
      currentLabel = p.label;
    }
    if (p.projectPath === p.baseDir) {
      console.log(`  \u{1F4C2} ${basename(p.baseDir)}`);
    } else {
      console.log(`  ${basename(p.projectPath)}`);
    }
  }
}

async function cmdTmux(opts: Opts): Promise<void> {
  const hosts = await loadHosts(opts.hostFilter);
  const { host, path } = await getProjectSelection(hosts, opts);
  const sessionName = basename(path);
  success(`Opening tmux session '${sessionName}' at ${path} on ${host}...`);
  const code = await execWithTtyRestore(
    "ssh",
    ["-A", "-t", host, `cd ${shellQuote(path)} && ~/bin/tc`],
  );
  deps.exit(code);
}

async function cmdCode(opts: Opts): Promise<void> {
  const hosts = await loadHosts(opts.hostFilter);
  const { host, path } = await getProjectSelection(hosts, opts);
  success(`Opening ${path} in VS Code on ${host}...`);
  deps.exit(await deps.exec("code", ["--remote", `ssh-remote+${host}`, path]));
}

async function cmdFinder(opts: Opts): Promise<void> {
  const hosts = await loadHosts(opts.hostFilter);
  const { host, path } = await getProjectSelection(hosts, opts);

  info("Resolving remote home directory...");
  const remoteHome = await sshGetHome(host);

  success(`Opening ${path} in Finder...`);
  const response = await agentSend(
    { action: "open", host, remoteHome, path },
    MOUNT_TIMEOUT_SEC,
  );

  if (response.ok) {
    if (typeof response.localPath === "string") {
      success(`Opened: ${response.localPath}`);
    }
  } else {
    error(deps.formatErrorMessage(response.error));
  }
}

async function cmdDefault(opts: Opts): Promise<void> {
  const hosts = await loadHosts(opts.hostFilter);
  const { host, path } = await getProjectSelection(hosts, opts);
  const projectDisplay = basename(path);

  const actions = ["tmux", "code"];
  if (deps.existsSync(SOCK)) actions.push("finder");

  const action = await fzfSelectSimple(actions, {
    prompt: "Action: ",
    header: `Open '${projectDisplay}' (${host}) with:`,
  });
  if (!action) {
    console.log("Cancelled.");
    deps.exit(0);
  }

  switch (action) {
    case "tmux": {
      const sessionName = basename(path);
      success(`Opening tmux session '${sessionName}' at ${path}...`);
      const code = await execWithTtyRestore(
        "ssh",
        ["-A", "-t", host, `cd ${shellQuote(path)} && ~/bin/tc`],
      );
      deps.exit(code);
    }
    // falls through (unreachable): deps.exit() above never returns
    case "code":
      success(`Opening ${path} in VS Code...`);
      deps.exit(
        await deps.exec("code", ["--remote", `ssh-remote+${host}`, path]),
      );
      break;
    case "finder": {
      info("Resolving remote home directory...");
      const remoteHome = await sshGetHome(host);
      success(`Opening ${path} in Finder...`);
      const response = await agentSend(
        { action: "open", host, remoteHome, path },
        MOUNT_TIMEOUT_SEC,
      );
      if (response.ok && typeof response.localPath === "string") {
        success(`Opened: ${response.localPath}`);
      } else if (!response.ok) {
        error(deps.formatErrorMessage(response.error));
      }
      break;
    }
  }
}

async function cmdSetup(opts: Opts): Promise<void> {
  const hosts = await loadHosts(opts.hostFilter);
  const seen = new Set<string>();

  for (const entry of hosts) {
    if (seen.has(entry.alias)) continue;
    seen.add(entry.alias);

    console.log(`
Host ${entry.alias}
    SetEnv OPEN_AGENT_HOST=${entry.alias}
    RemoteForward /tmp/open-agent.sock ~/.local/share/open-agent/open-agent.sock
    StreamLocalBindUnlink yes
    ServerAliveInterval 30
    ServerAliveCountMax 3`);
  }

  console.log();
  console.log(
    "# Add the above to ~/.ssh/config (optional — SetEnv requires AcceptEnv on the remote sshd).",
  );
  console.log();
  console.log("# Alternatively, create an identity file on each remote host:");
  for (const alias of seen) {
    console.log(
      `#   ssh ${alias} 'mkdir -p ~/.config/open-agent && echo ${alias} > ~/.config/open-agent/identity'`,
    );
  }
  console.log("#");
  console.log("# The hook resolves host identity in this order:");
  console.log("#   1. OPEN_AGENT_HOST env var (via SetEnv/AcceptEnv)");
  console.log("#   2. ~/.config/open-agent/identity file");
  console.log("#   (no hostname fallback — identity must be configured)");
}

async function cmdOpen(arg: string): Promise<void> {
  const pipeIdx = arg.indexOf("|");
  if (pipeIdx === -1) error("Invalid argument format. Expected 'host|path'");
  const host = arg.substring(0, pipeIdx);
  const path = arg.substring(pipeIdx + 1);
  if (!host || !path) error("Invalid argument format. Expected 'host|path'");
  await ensureRemoteToolkit(host);
  deps.exit(await deps.exec("code", ["--remote", `ssh-remote+${host}`, path]));
}

async function sshPreview(host: string, path: string): Promise<void> {
  const p = shellQuote(path);
  const result = await deps.run("ssh", [
    "-o",
    "ConnectTimeout=2",
    host,
    `echo ${p}; echo; ` +
    `if git -C ${p} rev-parse --git-dir >/dev/null 2>&1; then ` +
    `echo 'Branch:'; git -C ${p} branch --show-current 2>/dev/null; echo; ` +
    `echo 'Recent commits:'; git -C ${p} log --oneline -5 2>/dev/null; echo; fi; ` +
    `echo 'Contents:'; ls -1 ${p} 2>/dev/null | head -20`,
  ], { timeout: SSH_TIMEOUT_MS });
  if (result.stdout) console.log(result.stdout);
}

async function cmdPreviewMulti(meta: string): Promise<void> {
  const [host, ...pathParts] = meta.split("|");
  await sshPreview(host, pathParts.join("|"));
}

async function cmdPreview(
  host: string,
  dir: string,
  item: string,
): Promise<void> {
  if (item.startsWith("\u{1F4C2}")) {
    await sshPreview(host, dir);
  } else {
    const stripped = item.replace(/^\s*[├└]── /, "");
    await sshPreview(host, `${dir}/${stripped}`);
  }
}

// --- Help ---

function showHelp(): void {
  console.log(`Usage: ${SCRIPT_NAME} [command] [options] [project]

Commands:
    list    (l)   List remote projects
    tmux    (t)   Open tmux session for a project
    code    (c)   Open VS Code for a project
    finder  (f)   Open project in Finder via SSHFS (requires open-agent)
    setup         Print recommended SSH config for configured hosts
    open    (o)   Open from Alfred (host|path format)
    help          Show this help

    If no command is given, interactively select a project and action.

    A project may be host-qualified as HOST:PROJECT (e.g. m4mini:personal)
    to disambiguate duplicate names across hosts. HOST: alone pins the host
    and picks the project interactively. Conflicts with -h are an error.

    Hosts need not be configured: HOST:PROJECT probes the remote for a
    conventional project root (~/src, ~/code, ~/projects, ~/dev), and
    HOST:/abs/path (or HOST:~/path) opens a specific directory directly.
    If open-agent is not installed on the remote, rproj offers to deploy it.

Options:
    -h, --host HOST   Filter to a specific host alias (may be unconfigured)
    -p NAME           Project name (skip interactive selection)
    --json            Output as Alfred-compatible JSON (list command only)
    -q QUERY          Filter projects by query (list command with --json)
    --help            Show this help

Config:
    Hosts: ${OA_CONFIG_DIR}/remote-hosts
    Legacy: ${LEGACY_CONFIG_DIR}/hosts (auto-detected with warning)

Examples:
    ${SCRIPT_NAME}                         # Interactive: pick project & action
    ${SCRIPT_NAME} l                       # List all projects from all hosts
    ${SCRIPT_NAME} list -h workmbp         # List projects on workmbp only
    ${SCRIPT_NAME} list --json             # JSON output for Alfred
    ${SCRIPT_NAME} t                       # Interactive tmux selection
    ${SCRIPT_NAME} tmux -h workmbp proj    # Direct tmux on specific host
    ${SCRIPT_NAME} tmux m4mini:personal    # host:project — pin host inline
    ${SCRIPT_NAME} tmux m4mini:            # Pin host, pick project interactively
    ${SCRIPT_NAME} c                       # Interactive VS Code selection
    ${SCRIPT_NAME} f                       # Interactive: open project in Finder
    ${SCRIPT_NAME} setup                   # Print SSH config recommendations`);
}

// --- Main ---

export async function main(argv: string[], depsArg: CliDeps): Promise<void> {
  deps = depsArg;

  const home = deps.env.get("HOME") ?? "";
  if (!home) {
    console.error("HOME environment variable is not set");
    deps.exit(1);
  }
  const xdgConfig = deps.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
  OA_CONFIG_DIR = `${xdgConfig}/open-agent`;
  LEGACY_CONFIG_DIR = `${xdgConfig}/rproj`;

  const { command, debug } = parseArgs([...argv]);
  if (debug) debugMode = true;

  // Set JSON mode globally for logging
  if (command.cmd === "list" && command.json) {
    jsonMode = true;
  }

  switch (command.cmd) {
    case "list":
      await cmdList(command.opts, command.json, command.query);
      break;
    case "tmux":
      await cmdTmux(command.opts);
      break;
    case "code":
      await cmdCode(command.opts);
      break;
    case "finder":
      await cmdFinder(command.opts);
      break;
    case "default":
      await cmdDefault(command.opts);
      break;
    case "setup":
      await cmdSetup(command.opts);
      break;
    case "open":
      await cmdOpen(command.arg);
      break;
    case "preview_multi":
      await cmdPreviewMulti(command.meta);
      break;
    case "preview":
      await cmdPreview(command.host, command.dir, command.item);
      break;
    case "help":
      showHelp();
      break;
  }
}

if (import.meta.main) {
  main(Deno.args, realDeps).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      console.log(JSON.stringify({
        items: [{
          title: "Error",
          subtitle: msg,
          valid: false,
          icon: { path: "error.png" },
        }],
      }));
      Deno.exit(0);
    }
    console.error(red(`Error: ${msg}`));
    Deno.exit(1);
  });
}
