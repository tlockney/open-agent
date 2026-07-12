#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// rpull - pull a file from the local machine to this remote machine via open-agent
// Usage: rpull ~/Downloads/image.png           # copies to current directory
//        rpull ~/Desktop/file.txt ~/dest/dir/  # copies to specific remote directory

import { buildPullMessage, CliError, parseRpullArgs } from "./args.ts";
import {
  checkResponse,
  fail,
  getStringField,
  HOME,
  HOST,
  requireSock,
  send,
} from "../lib/oa.ts";

const USAGE = `Usage: rpull <local-path> [remote-dest]

Pull a file from the local Mac to this machine.
The local-path is a path on your personal Mac (e.g., ~/Downloads/file.txt).

Options:
  -h          Show this help

Arguments:
  local-path   Path on the local Mac
  remote-dest  Destination on this machine (default: current directory)

Examples:
  rpull ~/Downloads/image.png            # → ./image.png
  rpull ~/Desktop/notes.md ~/docs/       # → ~/docs/notes.md`;

let parsed: ReturnType<typeof parseRpullArgs>;
try {
  parsed = parseRpullArgs(Deno.args);
} catch (e) {
  if (e instanceof CliError) fail(e.message);
  throw e;
}

if (parsed.kind === "help") {
  console.log(USAGE);
  Deno.exit(0);
}

requireSock();

const localPath = parsed.localPath;
let remoteDest = parsed.remoteDest ?? Deno.cwd();

// Resolve remote dest to absolute path
try {
  remoteDest = Deno.realPathSync(remoteDest);
} catch {
  if (!remoteDest.startsWith("/")) {
    remoteDest = `${Deno.cwd()}/${remoteDest}`;
  }
}

const response = await send(
  buildPullMessage({ localPath, remoteDest, host: HOST, home: HOME }),
  30,
);

checkResponse(response);
console.log(`Pulled to: ${getStringField(response, "remotePath")}`);
