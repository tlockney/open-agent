#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// rpaste - paste from the local machine's clipboard via open-agent
// Usage: rpaste
//        rpaste | vim -

import {
  checkResponse,
  getStringField,
  isRemoteSession,
  requireSock,
  send,
} from "../lib/oa.ts";

if (!isRemoteSession()) {
  // Local Mac — read the system clipboard directly.
  const { code } = await new Deno.Command("pbpaste", {
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}

requireSock();

const response = await send({ action: "paste" });
checkResponse(response);

const content = getStringField(response, "content");
if (content) await Deno.stdout.write(new TextEncoder().encode(content));
