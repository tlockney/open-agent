#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

// open-agent — CLI for managing the open-agent remote development toolkit
//
// Subcommands:
//   setup-remote <host|all>   Deploy r* scripts and hook to remote host(s)
//   update                    Fetch and install latest release from GitHub
//   version                   Print version
//   help                      Show this help

import { blue, green, red, yellow } from "jsr:@std/fmt@1/colors";
import { existsSync } from "jsr:@std/fs@1/exists";
import { VERSION } from "../lib/version.ts";
import { buildDeployScript, REMOTE_COMMANDS } from "../lib/deploy.ts";

const REPO_OWNER = "tlockney";
const REPO_NAME = "open-agent";

const HOME = Deno.env.get("HOME") ?? "";
if (!HOME) {
  console.error("HOME environment variable is not set");
  Deno.exit(1);
}

const XDG_CONFIG = Deno.env.get("XDG_CONFIG_HOME") ?? `${HOME}/.config`;
const OA_CONFIG_DIR = `${XDG_CONFIG}/open-agent`;
const LEGACY_HOSTS_FILE = `${XDG_CONFIG}/rproj/hosts`;
const HOSTS_FILE = `${OA_CONFIG_DIR}/remote-hosts`;

// Resolve SCRIPT_DIR — the directory containing this script
const SCRIPT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

function info(msg: string): void {
  console.log(`${green("✓")} ${msg}`);
}
function warn(msg: string): void {
  console.log(`${yellow("⚠")} ${msg}`);
}
function step(msg: string): void {
  console.log(`${blue("→")} ${msg}`);
}

function fail(msg: string): never {
  console.error(`${red("✗")} ${msg}`);
  Deno.exit(1);
}

// --- Utilities ---

async function run(
  cmd: string,
  args: string[],
  opts?: {
    stdin?: "inherit" | "null" | "piped";
    input?: Uint8Array;
    timeout?: number;
  },
): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(cmd, {
    args,
    stdin: opts?.stdin ?? "null",
    stdout: "piped",
    stderr: "piped",
    signal: opts?.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
  });
  try {
    let child: Deno.CommandOutput;
    if (opts?.input) {
      const proc = command.spawn();
      const writer = proc.stdin.getWriter();
      await writer.write(opts.input);
      await writer.close();
      child = await proc.output();
    } else {
      child = await command.output();
    }
    return {
      success: child.success,
      stdout: new TextDecoder().decode(child.stdout).trim(),
      stderr: new TextDecoder().decode(child.stderr).trim(),
      code: child.code,
    };
  } catch {
    return { success: false, stdout: "", stderr: "command failed", code: 1 };
  }
}

// --- Config ---

function loadHostAliases(): string[] {
  let hostsPath = HOSTS_FILE;
  if (!existsSync(hostsPath)) {
    if (existsSync(LEGACY_HOSTS_FILE)) {
      hostsPath = LEGACY_HOSTS_FILE;
      warn(`Using legacy hosts file at ${hostsPath}`);
    } else {
      fail(
        `No hosts file found at ${HOSTS_FILE}\nCreate it with format: host_alias|project_dir|label`,
      );
    }
  }

  const text = Deno.readTextFileSync(hostsPath);
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const alias = trimmed.split("|")[0].trim();
    if (alias && !seen.has(alias)) seen.add(alias);
  }
  return [...seen];
}

// --- Commands ---

async function cmdSetupRemote(target: string): Promise<void> {
  if (!target) fail("Usage: open-agent setup-remote <host|all>");

  let hosts: string[];
  if (target === "all") {
    hosts = loadHostAliases();
    if (hosts.length === 0) fail("No hosts found in config");
    step(`Deploying to ${hosts.length} host(s): ${hosts.join(", ")}`);
  } else {
    hosts = [target];
  }

  // Resolve paths relative to SCRIPT_DIR (src/cli/) → project root is ../../
  const projectRoot = `${SCRIPT_DIR}/../..`;

  // Find open-agent-hook.sh
  let hookPath = `${projectRoot}/open-agent-hook.sh`;
  if (!existsSync(hookPath)) {
    hookPath = `${HOME}/.local/share/open-agent/open-agent-hook.sh`;
  }
  if (!existsSync(hookPath)) fail("Cannot find open-agent-hook.sh");

  // Find oa-wrapper.sh
  let wrapperPath = `${projectRoot}/oa-wrapper.sh`;
  if (!existsSync(wrapperPath)) {
    wrapperPath = `${HOME}/.local/share/open-agent/oa-wrapper.sh`;
  }
  if (!existsSync(wrapperPath)) fail("Cannot find oa-wrapper.sh");

  // Build tarball with new src/ layout
  step("Building deploy package...");
  const tmpDir = Deno.makeTempDirSync();

  // Create directory structure matching remote install layout
  await Deno.mkdir(`${tmpDir}/src/lib`, { recursive: true });
  await Deno.mkdir(`${tmpDir}/src/cli`, { recursive: true });

  // Copy shared library modules
  const libDir = `${SCRIPT_DIR}/../lib`;
  for await (const entry of Deno.readDir(libDir)) {
    if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      await Deno.copyFile(
        `${libDir}/${entry.name}`,
        `${tmpDir}/src/lib/${entry.name}`,
      );
    }
  }

  // Copy remote CLI scripts
  const remoteScripts = [...REMOTE_COMMANDS];
  for (const script of remoteScripts) {
    const src = `${SCRIPT_DIR}/${script}.ts`;
    if (existsSync(src)) {
      await Deno.copyFile(src, `${tmpDir}/src/cli/${script}.ts`);
    }
  }

  // Shared CLI modules the remote scripts import (not commands themselves,
  // so they must not appear in remoteScripts / the wrapper symlink list)
  const sharedCliModules = ["args"];
  for (const mod of sharedCliModules) {
    await Deno.copyFile(
      `${SCRIPT_DIR}/${mod}.ts`,
      `${tmpDir}/src/cli/${mod}.ts`,
    );
  }

  await Deno.copyFile(hookPath, `${tmpDir}/open-agent-hook.sh`);
  await Deno.copyFile(wrapperPath, `${tmpDir}/oa-wrapper.sh`);

  // Create tarball
  const tarball = `${tmpDir}/deploy.tar.gz`;
  const tarResult = await run("tar", [
    "-czf",
    tarball,
    "-C",
    tmpDir,
    "src",
    "open-agent-hook.sh",
    "oa-wrapper.sh",
  ]);
  if (!tarResult.success) fail("Failed to create deploy tarball");

  let failed = 0;
  for (const host of hosts) {
    console.log();
    step(`Deploying to ${host}...`);

    // Validate SSH connectivity
    const sshCheck = await run("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      host,
      "true",
    ], { timeout: 8000 });
    if (!sshCheck.success) {
      warn(`Cannot connect to ${host} (skipping)`);
      failed++;
      continue;
    }

    // Create remote directories
    await run("ssh", [host, "mkdir -p ~/.local/bin ~/.local/share/open-agent"]);

    // Deploy tarball
    const tarballBytes = await Deno.readFile(tarball);
    const deployResult = await run("ssh", [
      host,
      buildDeployScript(remoteScripts),
    ], { stdin: "piped", input: tarballBytes });

    for (const line of deployResult.stdout.split("\n")) {
      const warning = line.trim();
      if (warning.startsWith("oa-warn:")) {
        warn(`${host}: ${warning.slice("oa-warn:".length).trim()}`);
      }
    }

    if (deployResult.success) {
      info(`${host}: deployed successfully`);
    } else {
      warn(`${host}: deployment failed`);
      if (deployResult.stderr) console.error(`  ${deployResult.stderr}`);
      failed++;
    }
  }

  // Cleanup
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore */ }

  console.log();
  if (failed === 0) {
    info("All hosts deployed successfully");
  } else {
    warn(`${failed} host(s) failed`);
  }

  console.log(`
Post-deploy steps on each remote host:
  1. Ensure ~/.local/bin is in PATH:
     export PATH="$HOME/.local/bin:$PATH"

  2. Source the hook in ~/.zshrc (or ~/.bashrc):
     source ~/.local/share/open-agent/open-agent-hook.sh

  3. Reconnect SSH to activate the forwarded socket.`);
}

async function cmdUpdate(): Promise<void> {
  step("Checking for latest release...");

  const apiResult = await run("curl", [
    "-fsSL",
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
  ]);
  if (!apiResult.success) fail("Could not fetch latest release from GitHub");

  const tagMatch = apiResult.stdout.match(/"tag_name"\s*:\s*"([^"]+)"/);
  if (!tagMatch) fail("Could not parse release tag from GitHub API response");
  const latestTag = tagMatch[1];

  step(`Latest release: ${latestTag}`);

  const tmpDir = Deno.makeTempDirSync();
  const tarballUrl =
    `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${latestTag}/${REPO_NAME}-${latestTag}.tar.gz`;

  step(`Downloading ${tarballUrl}...`);
  const dlResult = await run("curl", [
    "-fsSL",
    tarballUrl,
    "-o",
    `${tmpDir}/release.tar.gz`,
  ]);
  if (!dlResult.success) {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore */ }
    fail("Failed to download release tarball");
  }

  step("Extracting...");
  await run("tar", ["xzf", `${tmpDir}/release.tar.gz`, "-C", tmpDir]);

  // Find extracted directory
  let extracted = "";
  for await (const entry of Deno.readDir(tmpDir)) {
    if (entry.isDirectory && entry.name.startsWith(`${REPO_NAME}-`)) {
      extracted = `${tmpDir}/${entry.name}`;
      break;
    }
  }
  if (!extracted) extracted = tmpDir;

  step("Installing...");
  const installScript = `${extracted}/install.sh`;
  if (!existsSync(installScript)) {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore */ }
    fail("install.sh not found in release tarball");
  }

  const installResult = await run("bash", [installScript, "--local"]);
  if (!installResult.success) {
    console.error(installResult.stderr);
    fail("Install failed");
  }
  if (installResult.stdout) console.log(installResult.stdout);

  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore */ }
  info("Update complete");
}

function cmdVersion(): void {
  console.log(`open-agent ${VERSION}`);
}

function showHelp(): void {
  console.log(`Usage: open-agent <command> [args]

Commands:
    setup-remote <host|all>   Deploy r* scripts and hook to remote host(s)
    update                    Fetch and install latest release from GitHub
    version                   Print version
    help                      Show this help

Config:
    Hosts file: ${HOSTS_FILE}
    Format: host_alias|project_dir|label (one per line)

Examples:
    open-agent setup-remote workmbp     # Deploy to a single host
    open-agent setup-remote all         # Deploy to all configured hosts
    open-agent update                   # Update to latest release`);
}

// --- Main ---

async function main(): Promise<void> {
  const [command, ...rest] = Deno.args;

  if (!command) {
    showHelp();
    Deno.exit(0);
  }

  switch (command) {
    case "setup-remote":
      await cmdSetupRemote(rest[0] ?? "");
      break;
    case "update":
      await cmdUpdate();
      break;
    case "status":
      fail(
        "'open-agent status' has been removed — use 'ra status' (summary),\n" +
          "  'ra mounts' (per-mount detail), or 'ra doctor' (full diagnostic).",
      );
      break;
    case "version":
      cmdVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      fail(`Unknown command: ${command}. See 'open-agent help'`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(red(`✗ ${msg}`));
  Deno.exit(1);
});
