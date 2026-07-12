#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
// rcopy - copy stdin to the local machine's clipboard via open-agent
// Usage: echo "text" | rcopy
//        cat file.txt | rcopy

import {
  checkResponse,
  fail,
  isRemoteSession,
  requireSock,
  send,
} from "../lib/oa.ts";

const input = await new Response(Deno.stdin.readable).text();
if (!input) fail("no input on stdin");

if (!isRemoteSession()) {
  // Local Mac — copy straight to the system clipboard.
  const proc = new Deno.Command("pbcopy", { stdin: "piped" }).spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  writer.releaseLock();
  const { code } = await proc.status;
  Deno.exit(code);
}

requireSock();

const response = await send({ action: "copy", content: input });
checkResponse(response);
