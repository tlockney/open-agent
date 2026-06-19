#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// ropen - remote open wrapper
// Sends open/vscode requests to the local open-agent via Unix socket or TCP.
// Surfaces a structured error (and recovery hint) when the agent is
// unreachable instead of silently falling back to native /usr/bin/open
// — a remote-mount path opened locally just produces nonsense.

import {
  buildOpenMessage,
  CliError,
  isUrl,
  isVsCodeApp,
  parseRopenFlags,
} from "./args.ts";
import {
  fail,
  formatErrorMessage,
  HOME,
  HOST,
  isRemoteSession,
  send,
} from "../lib/oa.ts";

const USAGE = `Usage: ropen [options] <path|url>

Options:
  -a <app>    Open with specific application (e.g., -a "Marked 2")
  -v          Open as VS Code remote project (uses code --remote)
  -h          Show this help

Examples:
  ropen README.md                    # Open with default app on local machine
  ropen -a "Marked 2" doc.md         # Open with specific app
  ropen -v ~/projects/myapp          # Open folder in local VS Code via remote-ssh
  ropen https://github.com/foo/bar   # Open URL in local browser`;

let flags: ReturnType<typeof parseRopenFlags>;
try {
  flags = parseRopenFlags(Deno.args);
} catch (e) {
  if (e instanceof CliError) fail(e.message);
  throw e;
}

if (flags.help) {
  console.log(USAGE);
  Deno.exit(0);
}

if (flags.positional.length === 0) {
  fail("No path specified. See ropen -h for usage.");
}

let target = flags.positional[0];
const app = flags.app;
const vscode = flags.vscode;

if (!isUrl(target)) {
  // Resolve to absolute path
  try {
    target = Deno.realPathSync(target);
  } catch {
    if (!target.startsWith("/")) {
      target = `${Deno.cwd()}/${target}`;
    }
  }
}

// Not in an SSH session — we're on the local Mac, so the agent round-trip
// is pointless and `target` is already a real local path. Run native open
// (or VS Code) directly. Note: this only triggers when we were never
// remote; the agent-unreachable-while-remote case below still errors loudly.
if (!isRemoteSession()) {
  let cmdArgs: string[];
  if (isUrl(target)) {
    cmdArgs = ["open", target];
  } else if (vscode || isVsCodeApp(app)) {
    cmdArgs = ["code", target];
  } else if (app) {
    cmdArgs = ["open", "-a", app, target];
  } else {
    cmdArgs = ["open", target];
  }
  const { code } = await new Deno.Command(cmdArgs[0], {
    args: cmdArgs.slice(1),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}

// Build message (URL → open-url; VS Code app name or -v → open-vscode; etc.)
const msg = buildOpenMessage({ target, app, vscode, host: HOST, home: HOME });

// Send to agent (tries Unix socket, then TCP)
let response: import("../lib/messages.ts").Response;
try {
  response = await send(msg);
} catch (e) {
  // No native-open fallback — that path silently produced "file not
  // found" errors when the SSHFS mount was gone. Surface the real cause
  // and point at the diagnostic command instead.
  const detail = e instanceof Error ? e.message : String(e);
  fail(
    `agent unreachable: ${detail}\n` +
      `  → SSH tunnel may have died. Reconnect SSH, or run 'ra ping' to diagnose.`,
  );
}

// Handle response
if (response.ok) {
  const localPath = response.localPath;
  if (typeof localPath === "string") {
    console.log(`Opened: ${localPath}`);
  }
} else {
  fail(formatErrorMessage(response.error));
}
