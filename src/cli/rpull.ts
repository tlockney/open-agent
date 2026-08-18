#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// rpull - pull a file from the local machine to this remote machine via open-agent
// Usage: rpull ~/Downloads/image.png           # copies to current directory
//        rpull ~/Desktop/file.txt ~/dest/dir/  # copies to specific remote directory

import { buildPullMessage, CliError, parseRpullArgs } from "./args.ts";
import { type CliDeps, realDeps } from "./deps.ts";

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

export async function main(argv: string[], deps: CliDeps): Promise<void> {
  let parsed: ReturnType<typeof parseRpullArgs>;
  try {
    parsed = parseRpullArgs(argv);
  } catch (e) {
    if (e instanceof CliError) deps.fail(e.message);
    throw e;
  }

  if (parsed.kind === "help") {
    console.log(USAGE);
    deps.exit(0);
  }

  deps.requireSock();

  const localPath = parsed.localPath;
  let remoteDest = parsed.remoteDest ?? deps.cwd();

  // Resolve remote dest to absolute path
  try {
    remoteDest = deps.realPathSync(remoteDest);
  } catch {
    if (!remoteDest.startsWith("/")) {
      remoteDest = `${deps.cwd()}/${remoteDest}`;
    }
  }

  const response = await deps.send(
    buildPullMessage({
      localPath,
      remoteDest,
      host: deps.requireHost(),
      home: deps.env.get("HOME") ?? "",
    }),
    30,
  );

  deps.checkResponse(response);
  console.log(`Pulled to: ${deps.getStringField(response, "remotePath")}`);
}

if (import.meta.main) main(Deno.args, realDeps);
