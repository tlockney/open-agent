#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
// rcopy - copy stdin to the local machine's clipboard via open-agent
// Usage: echo "text" | rcopy
//        cat file.txt | rcopy

import { type CliDeps, realDeps } from "./deps.ts";

export async function main(_argv: string[], deps: CliDeps): Promise<void> {
  const input = await new Response(deps.stdin.readable).text();
  if (!input) deps.fail("no input on stdin");

  if (!deps.isRemoteSession()) {
    // Local Mac — copy straight to the system clipboard.
    const proc = deps.spawnPiped("pbcopy");
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    writer.releaseLock();
    deps.exit(await proc.status);
  }

  deps.requireSock();

  let response;
  try {
    response = await deps.send({ action: "copy", content: input });
  } catch (e) {
    deps.fail(
      `agent unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  deps.checkResponse(response);
}

if (import.meta.main) main(Deno.args, realDeps);
