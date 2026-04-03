#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net=127.0.0.1:19876
// rnotify - send a macOS notification to the local machine via open-agent
// Usage: rnotify "Build complete"
//        rnotify "CI" "All tests passed"
//        rnotify -s "Ping" "Title" "Message"

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import type { Message } from "../lib/messages.ts";
import { send, requireSock, checkResponse, fail } from "../lib/oa.ts";

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

const args = parseArgs(Deno.args, {
  string: ["s", "u"],
  boolean: ["h"],
});

if (args.h) { console.log(USAGE); Deno.exit(0); }

const positional = args._ as string[];
if (positional.length === 0) fail("title required. See rnotify -h");

requireSock();

const msg: Message = {
  action: "notify",
  title: String(positional[0]),
  ...(positional[1] !== undefined && { message: String(positional[1]) }),
  ...(args.u && { subtitle: args.u }),
  ...(args.s && { sound: args.s }),
};

const response = await send(msg);
checkResponse(response);
