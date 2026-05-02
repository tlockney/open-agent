#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// ropen - remote open wrapper
// Sends open/vscode requests to the local open-agent via Unix socket or TCP.
// Surfaces a structured error (and recovery hint) when the agent is
// unreachable instead of silently falling back to native /usr/bin/open
// — a remote-mount path opened locally just produces nonsense.

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import type { Message } from "../lib/messages.ts";
import { fail, formatErrorMessage, HOME, HOST, send } from "../lib/oa.ts";

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

const args = parseArgs(Deno.args, {
  string: ["a"],
  boolean: ["v", "h"],
  "--": false,
  unknown: (opt) => {
    if (opt.startsWith("-")) fail(`Unknown option: ${opt}`);
    return true;
  },
});

if (args.h) { console.log(USAGE); Deno.exit(0); }

const positional = args._ as string[];
if (positional.length === 0) fail("No path specified. See ropen -h for usage.");

let target = String(positional[0]);
let app = args.a ?? "";
let vscode = args.v;

// Detect URLs
const isUrl = /^https?:\/\//.test(target);

if (!isUrl) {
  // Resolve to absolute path
  try {
    target = Deno.realPathSync(target);
  } catch {
    if (!target.startsWith("/")) {
      target = `${Deno.cwd()}/${target}`;
    }
  }
}

// Detect VS Code by app name
if (app.includes("Visual Studio Code") || (app.includes("Code") && !app.includes("Xcode"))) {
  vscode = true;
  app = "";
}

// Build message
let msg: Message;
if (isUrl) {
  msg = { action: "open-url", url: target };
} else if (vscode) {
  msg = { action: "open-vscode", host: HOST, path: target };
} else if (app) {
  msg = { action: "open", host: HOST, remoteHome: HOME, path: target, app };
} else {
  msg = { action: "open", host: HOST, remoteHome: HOME, path: target };
}

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
