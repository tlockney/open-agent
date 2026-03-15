// oa.ts — Shared utilities for remote-side scripts that communicate
// with the open-agent daemon via Unix socket.
//
// Usage:
//   import { send, requireSock, fail, SOCK, HOST, HOME } from "./lib/oa.ts";

import { existsSync } from "jsr:@std/fs@1/exists";

export const HOME = Deno.env.get("HOME") ?? "";
export const SOCK = Deno.env.get("OPEN_AGENT_SOCK") ?? "/tmp/open-agent.sock";
export const HOST = Deno.env.get("OPEN_AGENT_HOST") ?? "workmbp";
export const SCRIPT_NAME = new URL(import.meta.url).pathname.split("/").at(-2) ?? "oa";

export function fail(msg: string): never {
  console.error(`${callerName()}: ${msg}`);
  Deno.exit(1);
}

// Derive the calling script name from the main module, not this library
function callerName(): string {
  try {
    const main = Deno.mainModule;
    return new URL(main).pathname.split("/").pop()?.replace(/\.ts$/, "") ?? "oa";
  } catch {
    return "oa";
  }
}

export function requireSock(): void {
  if (!existsSync(SOCK)) {
    fail(`agent socket not found at ${SOCK}`);
  }
}

export async function send(
  message: Record<string, unknown>,
  timeoutSec = 5,
): Promise<Record<string, unknown>> {
  let conn: Deno.UnixConn;
  try {
    conn = await Deno.connect({ transport: "unix", path: SOCK });
  } catch {
    throw new Error("failed to connect to agent socket");
  }
  try {
    const payload = JSON.stringify(message) + "\n";
    await conn.write(new TextEncoder().encode(payload));

    // Read with timeout
    const buf = new Uint8Array(65536);
    const timer = setTimeout(() => conn.close(), timeoutSec * 1000);
    const n = await conn.read(buf);
    clearTimeout(timer);
    if (!n) throw new Error("no response from agent");
    return JSON.parse(new TextDecoder().decode(buf.subarray(0, n)).trim()) as Record<string, unknown>;
  } finally {
    try { conn.close(); } catch { /* already closed */ }
  }
}

export function checkResponse(response: Record<string, unknown>): void {
  if (response.ok !== true) {
    const err = typeof response.error === "string" ? response.error : "unknown error";
    fail(err);
  }
}

export function getStringField(response: Record<string, unknown>, key: string): string {
  const val = response[key];
  return typeof val === "string" ? val : "";
}
