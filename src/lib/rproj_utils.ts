// rproj_utils.ts — Pure utility functions extracted from rproj for testability.

import { basename } from "jsr:@std/path@1/basename";
import { parseArgs as denoParseArgs } from "jsr:@std/cli@1/parse-args";

// --- Types ---

export interface HostEntry {
  alias: string;
  dir: string;
  label: string;
}

export interface ProjectEntry {
  host: string;
  baseDir: string;
  projectPath: string;
  label: string;
}

export interface ProjectMatch {
  host: string;
  path: string;
}

// --- Shell utilities ---

/**
 * Escape a string for safe use inside single quotes in shell commands.
 * Handles the only dangerous character: single quote itself.
 * 'foo'bar' becomes 'foo'\''bar'
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// --- Host-qualified project names ---

/**
 * Split a possibly host-qualified project token into its host and name.
 *
 * Strict: splits on the FIRST colon only, so `host:sub:dir` yields
 * host `host` and name `sub:dir`. A token with no colon has no host.
 * A trailing colon (`host:`) yields an empty name, which callers treat
 * as "pin the host, pick the project interactively".
 *
 * Throws on a leading colon (`:name`) — an empty host is always a
 * mistake rather than a meaningful selection.
 */
export function splitHostQualifier(
  raw: string,
): { host: string | null; name: string } {
  const idx = raw.indexOf(":");
  if (idx === -1) return { host: null, name: raw };
  if (idx === 0) {
    throw new Error(`empty host in '${raw}' (expected 'host:project')`);
  }
  return { host: raw.slice(0, idx), name: raw.slice(idx + 1) };
}

// --- Terminal restore ---

/**
 * Bytes that undo the terminal-side state changes a remote tmux session
 * normally tears down on a clean exit but cannot when the SSH connection
 * dies abruptly. Sending these locally is what stops the terminal from
 * being stuck in alt-screen / mouse-tracking / paste mode and prevents
 * the post-disconnect flood of decoded mouse events appearing as text.
 *
 * Two axes of mouse state exist in xterm-style terminals (and we have to
 * clear both independently — they latch separately even though setting
 * a newer tracking mode typically replaces the older ones):
 *
 *   tracking (whether events are emitted):
 *     ?9    X10 compat            ?1001  highlight tracking
 *     ?1000 VT200 button-event    ?1002  cell-motion
 *     ?1003 all-motion
 *
 *   encoding (how events are framed on the wire):
 *     ?1005 UTF-8     ?1006 SGR     ?1015 URxvt     ?1016 SGR-pixels
 *
 * The URxvt encoding (?1015) is what's been leaking through here:
 * tmux negotiates it on some xterm-* / tmux-256color terminfo entries,
 * and a too-narrow cleanup leaves the terminal still emitting
 * `CSI Cb;Cx;Cy M` events that the user's shell then echoes as text.
 */
export const TERMINAL_RESTORE_SEQUENCE = "\x1b[?1049l" + // leave alternate screen buffer
  "\x1b[?9l" + // X10 mouse tracking off (legacy)
  "\x1b[?1000l" + // VT200 button-event mouse off
  "\x1b[?1001l" + // highlight mouse tracking off
  "\x1b[?1002l" + // cell-motion mouse tracking off
  "\x1b[?1003l" + // all-motion mouse tracking off
  "\x1b[?1004l" + // focus event reporting off
  "\x1b[?1005l" + // UTF-8 mouse encoding off
  "\x1b[?1006l" + // SGR mouse encoding off
  "\x1b[?1015l" + // URxvt mouse encoding off
  "\x1b[?1016l" + // SGR-Pixels mouse encoding off
  "\x1b[?2004l" + // bracketed paste mode off
  "\x1b[?25h" + // show cursor
  "\x1b(B"; // designate G0 to ASCII

// --- fzf formatting ---

/**
 * Build fzf-compatible entries from a list of projects.
 * Each line: `host|path\t<display>`
 * Projects are grouped by label with tree-style connectors.
 */
export function buildFzfEntries(projects: ProjectEntry[]): string {
  const lines: string[] = [];
  let currentLabel = "";
  let group: { meta: string; type: "parent" | "child"; name: string }[] = [];

  const flushGroup = (label: string) => {
    if (group.length === 0) return;
    const children = group.filter((g) => g.type === "child");
    let childIdx = 0;
    for (const entry of group) {
      if (entry.type === "parent") {
        lines.push(`${entry.meta}\t\u{1F4C2} ${label}`);
      } else {
        childIdx++;
        const connector = childIdx === children.length
          ? "\u2514\u2500\u2500"
          : "\u251C\u2500\u2500";
        lines.push(`${entry.meta}\t   ${connector} ${entry.name}`);
      }
    }
  };

  for (const p of projects) {
    if (p.label !== currentLabel) {
      flushGroup(currentLabel);
      currentLabel = p.label;
      group = [];
    }
    const meta = `${p.host}|${p.projectPath}`;
    if (p.projectPath === p.baseDir) {
      group.push({ meta, type: "parent", name: basename(p.baseDir) });
    } else {
      group.push({ meta, type: "child", name: basename(p.projectPath) });
    }
  }
  flushGroup(currentLabel);

  return lines.join("\n");
}

// --- Argument parsing ---

export interface Opts {
  hostFilter: string | null;
  projectName: string | null;
}

export type Command =
  | { cmd: "list"; opts: Opts; json: boolean; query: string }
  | { cmd: "tmux"; opts: Opts }
  | { cmd: "code"; opts: Opts }
  | { cmd: "finder"; opts: Opts }
  | { cmd: "default"; opts: Opts }
  | { cmd: "status" }
  | { cmd: "help" }
  | { cmd: "setup"; opts: Opts }
  | { cmd: "open"; arg: string }
  | { cmd: "preview"; host: string; dir: string; item: string }
  | { cmd: "preview_multi"; meta: string };

/** Resolved command plus whether `--debug` was requested. */
export interface ParsedCommand {
  command: Command;
  debug: boolean;
}

/**
 * Parse rproj's argv into a Command. Throws Error on bad input — the caller's
 * top-level catch renders it (matching the previous error() behavior). The
 * `debug` flag is returned rather than mutating a module global, which keeps
 * this function pure and testable.
 *
 * Note: a flag-only default invocation (e.g. `rproj --host foo`) currently
 * recurses to `parseArgs(["default", ...])`, which falls through to the
 * "Unknown command: default" error because there is no `case "default"` in
 * the switch. This is preserved here as the existing behavior.
 */
export function parseArgs(args: string[]): ParsedCommand {
  const DEFAULT_OPTS: Opts = { hostFilter: null, projectName: null };
  if (args.length === 0) {
    return { command: { cmd: "default", opts: DEFAULT_OPTS }, debug: false };
  }
  // Handle bare --debug with no subcommand
  if (args.length === 1 && args[0] === "--debug") {
    return { command: { cmd: "default", opts: DEFAULT_OPTS }, debug: true };
  }

  const first = args[0];

  // Internal preview commands (called by fzf)
  if (first === "_preview_multi") {
    return {
      command: { cmd: "preview_multi", meta: args[1] ?? "" },
      debug: false,
    };
  }
  if (first === "_preview") {
    return {
      command: {
        cmd: "preview",
        host: args[1] ?? "",
        dir: args[2] ?? "",
        item: args[3] ?? "",
      },
      debug: false,
    };
  }

  // Map short aliases
  const cmdMap: Record<string, string> = {
    l: "list",
    t: "tmux",
    c: "code",
    f: "finder",
    s: "status",
    o: "open",
  };
  const cmdName = cmdMap[first] ?? first;

  if (cmdName === "help" || cmdName === "--help") {
    return { command: { cmd: "help" }, debug: false };
  }
  if (cmdName === "status") return { command: { cmd: "status" }, debug: false };
  if (cmdName === "open") {
    const arg = args[1];
    if (arg === undefined) throw new Error("Usage: rproj open 'host|path'");
    return { command: { cmd: "open", arg }, debug: false };
  }

  // Parse flags from remaining args
  const parsed = denoParseArgs(args.slice(1), {
    string: ["host", "p", "q"],
    boolean: ["json", "help", "debug"],
    alias: { h: "host" },
    unknown: (opt) => {
      if (opt.startsWith("-")) throw new Error(`Unknown option: ${opt}`);
      return true;
    },
  });

  const debug = Boolean(parsed.debug);

  if (parsed.help) return { command: { cmd: "help" }, debug };

  const flagHost = (parsed.host as string | undefined) ?? null;
  const rawProject = (parsed.p as string | undefined) ??
    (parsed._[0] as string | undefined) ?? null;

  // A project token may carry a `host:` prefix (e.g. `m4mini:personal`).
  // Resolve it against the `-h` flag: the prefix sets the host filter, but
  // disagreeing with an explicit `-h` is a mistake worth flagging.
  let hostFilter = flagHost;
  let projectName = rawProject;
  if (rawProject !== null) {
    const split = splitHostQualifier(rawProject);
    if (split.host !== null) {
      if (flagHost !== null && flagHost !== split.host) {
        throw new Error(`host given twice (-h ${flagHost} vs ${split.host}:)`);
      }
      hostFilter = split.host;
    }
    projectName = split.name === "" ? null : split.name;
  }

  const opts: Opts = { hostFilter, projectName };

  switch (cmdName) {
    case "list":
      return {
        command: {
          cmd: "list",
          opts,
          json: !!parsed.json,
          query: (parsed.q as string | undefined) ?? "",
        },
        debug,
      };
    case "tmux":
      return { command: { cmd: "tmux", opts }, debug };
    case "code":
      return { command: { cmd: "code", opts }, debug };
    case "finder":
      return { command: { cmd: "finder", opts }, debug };
    case "setup":
      return { command: { cmd: "setup", opts }, debug };
    default:
      if (first.startsWith("-")) {
        return parseArgs(["default", ...args]);
      }
      throw new Error(`Unknown command: ${first}. Use 'rproj help' for usage.`);
  }
}
