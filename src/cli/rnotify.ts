#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// rnotify - send a macOS notification to the local machine via open-agent
// Usage: rnotify "Build complete"
//        rnotify "CI" "All tests passed"
//        rnotify -s "Ping" "Title" "Message"

import { CliError, parseRnotifyArgs } from "./args.ts";
import { checkResponse, fail, requireSock, send } from "../lib/oa.ts";

const USAGE = `Usage: rnotify [options] <title> [message]

Options:
  -s <sound>    Play a sound (e.g., "Ping", "Glass", "Hero")
  -u <subtitle> Add a subtitle
  -h            Show this help

Examples:
  rnotify "Build complete"
  rnotify "CI" "All 42 tests passed"
  rnotify -s Ping "Deploy" "Production deploy finished"
  rnotify -u "myproject" "Tests" "Suite passed in 3m12s"`;

let parsed: ReturnType<typeof parseRnotifyArgs>;
try {
  parsed = parseRnotifyArgs(Deno.args);
} catch (e) {
  if (e instanceof CliError) fail(e.message);
  throw e;
}

if (parsed.kind === "help") {
  console.log(USAGE);
  Deno.exit(0);
}

requireSock();

const response = await send(parsed.message);
checkResponse(response);
