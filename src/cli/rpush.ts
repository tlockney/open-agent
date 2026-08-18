#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// rpush - push a remote file to the local machine via open-agent
// Usage: rpush file.txt              # copies to local ~/Downloads
//        rpush -d ~/Desktop file.txt # copies to specific local directory

import { buildPushMessage, CliError, parseRpushArgs } from "./args.ts";
import { type CliDeps, realDeps } from "./deps.ts";

const USAGE = `Usage: rpush [options] <file>

Push a file from this machine to the local Mac.

Options:
  -d <dir>    Local destination directory (default: ~/Downloads)
  -h          Show this help

Examples:
  rpush build.tar.gz              # → local ~/Downloads/build.tar.gz
  rpush -d ~/Desktop report.pdf   # → local ~/Desktop/report.pdf`;

export async function main(argv: string[], deps: CliDeps): Promise<void> {
  let parsed: ReturnType<typeof parseRpushArgs>;
  try {
    parsed = parseRpushArgs(argv);
  } catch (e) {
    if (e instanceof CliError) deps.fail(e.message);
    throw e;
  }

  if (parsed.kind === "help") {
    console.log(USAGE);
    deps.exit(0);
  }

  deps.requireSock();

  let target = parsed.file;

  // Verify file exists and resolve to absolute path
  try {
    const stat = deps.statSync(target);
    if (!stat) deps.fail(`${target}: no such file`);
  } catch {
    deps.fail(`${target}: no such file`);
  }
  target = deps.realPathSync(target);

  const msg = buildPushMessage({
    path: target,
    dest: parsed.dest,
    host: deps.requireHost(),
    home: deps.env.get("HOME") ?? "",
  });

  const response = await deps.send(msg, 30);
  deps.checkResponse(response);
  console.log(`Pushed to: ${deps.getStringField(response, "localPath")}`);
}

if (import.meta.main) main(Deno.args, realDeps);
