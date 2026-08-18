#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// rnotify - send a macOS notification to the local machine via open-agent
// Usage: rnotify "Build complete"
//        rnotify "CI" "All tests passed"
//        rnotify -s "Ping" "Title" "Message"

import { CliError, parseRnotifyArgs } from "./args.ts";
import { type CliDeps, realDeps } from "./deps.ts";

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

export async function main(argv: string[], deps: CliDeps): Promise<void> {
  let parsed: ReturnType<typeof parseRnotifyArgs>;
  try {
    parsed = parseRnotifyArgs(argv);
  } catch (e) {
    if (e instanceof CliError) deps.fail(e.message);
    throw e;
  }

  if (parsed.kind === "help") {
    console.log(USAGE);
    deps.exit(0);
  }

  deps.requireSock();

  const response = await deps.send(parsed.message);
  deps.checkResponse(response);
}

if (import.meta.main) main(Deno.args, realDeps);
