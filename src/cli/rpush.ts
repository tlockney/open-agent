#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net=127.0.0.1:19876
// rpush - push a remote file to the local machine via open-agent
// Usage: rpush file.txt              # copies to local ~/Downloads
//        rpush -d ~/Desktop file.txt # copies to specific local directory

import { buildPushMessage, CliError, parseRpushArgs } from "./args.ts";
import {
  checkResponse,
  fail,
  getStringField,
  HOME,
  HOST,
  requireSock,
  send,
} from "../lib/oa.ts";

const USAGE = `Usage: rpush [options] <file>

Push a file from this machine to the local Mac.

Options:
  -d <dir>    Local destination directory (default: ~/Downloads)
  -h          Show this help

Examples:
  rpush build.tar.gz              # → local ~/Downloads/build.tar.gz
  rpush -d ~/Desktop report.pdf   # → local ~/Desktop/report.pdf`;

let parsed: ReturnType<typeof parseRpushArgs>;
try {
  parsed = parseRpushArgs(Deno.args);
} catch (e) {
  if (e instanceof CliError) fail(e.message);
  throw e;
}

if (parsed.kind === "help") {
  console.log(USAGE);
  Deno.exit(0);
}

requireSock();

let target = parsed.file;

// Verify file exists and resolve to absolute path
try {
  const stat = Deno.statSync(target);
  if (!stat) fail(`${target}: no such file`);
} catch {
  fail(`${target}: no such file`);
}
target = Deno.realPathSync(target);

const msg = buildPushMessage({
  path: target,
  dest: parsed.dest,
  host: HOST,
  home: HOME,
});

const response = await send(msg, 30);
checkResponse(response);
console.log(`Pushed to: ${getStringField(response, "localPath")}`);
