// args.ts — Pure argument parsers for the r* CLI commands.
//
// These functions take a raw argv array (and any environment-derived values
// they need as plain parameters) and return a structured result, or throw a
// CliError on bad input. They perform no I/O and never call Deno.exit, so the
// thin CLI scripts stay as orchestrators while the parsing logic is testable
// in isolation. Each script catches CliError and routes it to oa.ts's fail().

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import type { Message } from "../lib/messages.ts";

/**
 * Signals a user-facing argument error. Scripts catch this and forward the
 * message to fail() (which prints "<cmd>: <message>" and exits 1), matching
 * the behavior of the inline fail() calls these parsers replaced.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

// --- rnotify ---

type NotifyMessage = Extract<Message, { action: "notify" }>;

export type ParsedNotify =
  | { kind: "help" }
  | { kind: "notify"; message: NotifyMessage };

/** Parse `rnotify [-s sound] [-u subtitle] <title> [message]`. */
export function parseRnotifyArgs(argv: string[]): ParsedNotify {
  const args = parseArgs(argv, {
    string: ["s", "u"],
    boolean: ["h"],
  });

  if (args.h) return { kind: "help" };

  const positional = args._;
  if (positional.length === 0) {
    throw new CliError("title required. See rnotify -h");
  }

  const message: NotifyMessage = {
    action: "notify",
    title: String(positional[0]),
    ...(positional[1] !== undefined && { message: String(positional[1]) }),
    ...(args.u && { subtitle: args.u }),
    ...(args.s && { sound: args.s }),
  };
  return { kind: "notify", message };
}

// --- ropen ---

export interface RopenFlags {
  help: boolean;
  app: string;
  vscode: boolean;
  positional: string[];
}

/**
 * Parse `ropen [-a app] [-v] [-h] <path|url>` flags. Throws on any unknown
 * `-`-prefixed option, mirroring the original custom `unknown` handler.
 */
export function parseRopenFlags(argv: string[]): RopenFlags {
  const args = parseArgs(argv, {
    string: ["a"],
    boolean: ["v", "h"],
    "--": false,
    unknown: (opt) => {
      if (opt.startsWith("-")) throw new CliError(`Unknown option: ${opt}`);
      return true;
    },
  });

  return {
    help: Boolean(args.h),
    app: args.a ?? "",
    vscode: Boolean(args.v),
    positional: (args._ as (string | number)[]).map(String),
  };
}

/** True for any path/URL beginning with http:// or https://. */
export function isUrl(target: string): boolean {
  return /^https?:\/\//.test(target);
}

/**
 * Detect an app name that means "open in VS Code". Matches the full name or a
 * bare "Code", but deliberately excludes "Xcode" (which also contains "Code").
 */
export function isVsCodeApp(app: string): boolean {
  return app.includes("Visual Studio Code") ||
    (app.includes("Code") && !app.includes("Xcode"));
}

/**
 * Build the agent Message for `ropen`, given an already-resolved target. URLs
 * become open-url; a VS Code app name (or -v) becomes open-vscode; any other
 * -a app becomes an open with that app; otherwise a plain open.
 */
export function buildOpenMessage(
  opts: {
    target: string;
    app: string;
    vscode: boolean;
    host: string;
    home: string;
  },
): Message {
  const { target, host, home } = opts;
  let { app, vscode } = opts;

  if (isUrl(target)) return { action: "open-url", url: target };

  if (isVsCodeApp(app)) {
    vscode = true;
    app = "";
  }

  if (vscode) return { action: "open-vscode", host, path: target };
  if (app) return { action: "open", host, remoteHome: home, path: target, app };
  return { action: "open", host, remoteHome: home, path: target };
}

// --- rpush ---

export type ParsedPush =
  | { kind: "help" }
  | { kind: "push"; file: string; dest?: string };

/** Parse `rpush [-d dir] [-h] <file>`. */
export function parseRpushArgs(argv: string[]): ParsedPush {
  const args = parseArgs(argv, {
    string: ["d"],
    boolean: ["h"],
  });

  if (args.h) return { kind: "help" };

  const positional = args._;
  if (positional.length === 0) {
    throw new CliError("file required. See rpush -h");
  }

  return {
    kind: "push",
    file: String(positional[0]),
    ...(args.d && { dest: args.d }),
  };
}

/** Build the push Message for an already-resolved absolute path. */
export function buildPushMessage(
  opts: { path: string; dest?: string; host: string; home: string },
): Message {
  return {
    action: "push",
    host: opts.host,
    remoteHome: opts.home,
    path: opts.path,
    ...(opts.dest && { dest: opts.dest }),
  };
}

// --- rpull ---

export type ParsedPull =
  | { kind: "help" }
  | { kind: "pull"; localPath: string; remoteDest?: string };

/** Parse `rpull <local-path> [remote-dest]` (manual positional parsing). */
export function parseRpullArgs(argv: string[]): ParsedPull {
  if (argv[0] === "-h" || argv[0] === "--help") return { kind: "help" };
  if (argv.length === 0) {
    throw new CliError("local path required. See rpull -h");
  }

  return {
    kind: "pull",
    localPath: argv[0],
    ...(argv[1] !== undefined && { remoteDest: argv[1] }),
  };
}

/** Build the pull Message for an already-resolved remote destination. */
export function buildPullMessage(
  opts: { localPath: string; remoteDest: string; host: string; home: string },
): Message {
  return {
    action: "pull",
    host: opts.host,
    remoteHome: opts.home,
    localPath: opts.localPath,
    remoteDest: opts.remoteDest,
  };
}

// --- rop ---

/**
 * Pull the global `--account <value>` option out of argv from anywhere it
 * appears. Returns the account (if any) and the remaining args in order.
 */
export function extractAccount(
  argv: string[],
): { account?: string; rest: string[] } {
  let account: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--account") {
      i++;
      if (i >= argv.length) throw new CliError("--account requires a value");
      account = argv[i];
    } else {
      rest.push(argv[i]);
    }
  }
  return account === undefined ? { rest } : { account, rest };
}

/** Validate and return the op:// reference for `rop read <ref>`. */
export function parseReadRef(args: string[]): string {
  if (args.length === 0) throw new CliError("read requires an op:// reference");
  const ref = args[0];
  if (!ref.startsWith("op://")) {
    throw new CliError("reference must start with op://");
  }
  return ref;
}

/**
 * Split `rop run [--env-file f]... -- <cmd...>` into its env-file list and the
 * command after `--`. Throws on a stray pre-`--` argument, a missing separator,
 * or an empty command, matching the original inline checks.
 */
export function splitRunArgs(
  args: string[],
): { envFiles: string[]; cmdArgs: string[] } {
  const envFiles: string[] = [];
  let cmdArgs: string[] = [];
  let foundSeparator = false;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--env-file") {
      i++;
      if (i >= args.length) {
        throw new CliError("--env-file requires a filename");
      }
      envFiles.push(args[i]);
    } else if (args[i] === "--") {
      foundSeparator = true;
      cmdArgs = args.slice(i + 1);
      break;
    } else {
      throw new CliError(`unexpected argument before --: ${args[i]}`);
    }
    i++;
  }

  if (!foundSeparator) {
    throw new CliError("missing -- separator before command");
  }
  if (cmdArgs.length === 0) throw new CliError("no command specified after --");
  return { envFiles, cmdArgs };
}

export interface EnvLine {
  key: string;
  value: string;
  isRef: boolean;
}

/**
 * Parse a single env-file line. Returns null for blank/comment/unparseable
 * lines. Surrounding single or double quotes are stripped, and a value
 * beginning with op:// is flagged as a 1Password reference.
 */
export function parseEnvLine(line: string): EnvLine | null {
  if (!line.trim() || line.trim().startsWith("#")) return null;
  const match = line.match(/^([A-Za-z_]\w*)=\s*(.*)/);
  if (!match) return null;
  const key = match[1];
  const value = match[2].replace(/^["']|["']$/g, "");
  return { key, value, isRef: value.startsWith("op://") };
}

// --- ra ---

export type RaSubcommand = "ping" | "status" | "mounts" | "reset" | "doctor";

export type ParsedRa =
  | { kind: "help" }
  | { kind: "run"; command: RaSubcommand; host?: string };

/**
 * Parse the `ra <command> [args]` subcommand. An empty/help subcommand yields
 * help; an unrecognized one throws (the script appends USAGE to the message).
 */
export function parseRaCommand(argv: string[]): ParsedRa {
  const sub = argv[0] ?? "";
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }
  switch (sub) {
    case "ping":
    case "status":
    case "mounts":
    case "doctor":
      return { kind: "run", command: sub };
    case "reset":
      return argv[1] !== undefined
        ? { kind: "run", command: "reset", host: argv[1] }
        : { kind: "run", command: "reset" };
    default:
      throw new CliError(`unknown command: ${sub}`);
  }
}
