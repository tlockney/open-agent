#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
// rpaste - paste from the local machine's clipboard via open-agent
// Usage: rpaste
//        rpaste | vim -

import { type CliDeps, realDeps } from "./deps.ts";

export async function main(_argv: string[], deps: CliDeps): Promise<void> {
  if (!deps.isRemoteSession()) {
    // Local Mac — read the system clipboard directly.
    deps.exit(await deps.exec("pbpaste", []));
  }

  deps.requireSock();

  let response;
  try {
    response = await deps.send({ action: "paste" });
  } catch (e) {
    deps.fail(
      `agent unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  deps.checkResponse(response);

  const content = deps.getStringField(response, "content");
  if (content) await deps.stdout.write(new TextEncoder().encode(content));
}

if (import.meta.main) main(Deno.args, realDeps);
