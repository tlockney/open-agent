// oa.ts — Shared utilities for remote-side scripts that communicate
// with the open-agent daemon via Unix socket or TCP fallback.
//
// Usage:
//   import { send, requireSock, fail, SOCK, HOST, HOME } from "./lib/oa.ts";

import { existsSync } from "jsr:@std/fs@1/exists";
import type { Message, Response, OkResponse } from "./messages.ts";

export const HOME = Deno.env.get("HOME") ?? "";
export const SOCK = Deno.env.get("OPEN_AGENT_SOCK") ?? "/tmp/open-agent.sock";
export const TCP_HOST = Deno.env.get("OPEN_AGENT_TCP_HOST") ?? "127.0.0.1";
export const TCP_PORT = parseInt(Deno.env.get("OPEN_AGENT_TCP_PORT") ?? "19876", 10);
// Resolve host identity: env var → identity file → hostname fallback
function resolveHost(): string {
  const envHost = Deno.env.get("OPEN_AGENT_HOST");
  if (envHost) return envHost;

  const identityPath = `${Deno.env.get("HOME") ?? ""}/.config/open-agent/identity`;
  try {
    return Deno.readTextFileSync(identityPath).trim();
  } catch { /* file doesn't exist */ }

  return "unknown";
}
export const HOST = resolveHost();
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
    // Socket missing — TCP may still work, so just warn
    console.error(`${callerName()}: socket not found at ${SOCK}, will try TCP ${TCP_HOST}:${TCP_PORT}`);
  }
}

const CONNECT_TIMEOUT_MS = 2000;

function connectWithTimeout(
  opts: Deno.ConnectOptions | Deno.UnixConnectOptions,
  ms: number,
): Promise<Deno.Conn> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), ms);
    const connect = "path" in opts
      ? Deno.connect(opts as Deno.UnixConnectOptions)
      : Deno.connect(opts as Deno.ConnectOptions);
    connect.then(
      (conn) => { clearTimeout(timer); resolve(conn); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Send a message over a specific transport and return the parsed response. */
async function sendVia(
  opts: Deno.ConnectOptions | Deno.UnixConnectOptions,
  message: Message,
  timeoutSec: number,
): Promise<Response> {
  const conn = await connectWithTimeout(opts, CONNECT_TIMEOUT_MS);
  try {
    const payload = JSON.stringify(message) + "\n";
    await conn.write(new TextEncoder().encode(payload));

    const buf = new Uint8Array(65536);
    const timer = setTimeout(() => conn.close(), timeoutSec * 1000);
    const n = await conn.read(buf);
    clearTimeout(timer);
    if (!n) throw new Error("no response from agent");
    return JSON.parse(new TextDecoder().decode(buf.subarray(0, n)).trim()) as Response;
  } finally {
    try { conn.close(); } catch { /* already closed */ }
  }
}

export async function send(
  message: Message,
  timeoutSec = 5,
): Promise<Response> {
  // Try Unix socket first. If the socket exists but the tunnel is dead
  // (common with SSH-forwarded sockets after a disconnect), the send will
  // time out and we fall through to TCP — no separate probe needed.
  if (existsSync(SOCK)) {
    try {
      return await sendVia(
        { transport: "unix", path: SOCK } as Deno.UnixConnectOptions,
        message,
        timeoutSec,
      );
    } catch { /* fall through to TCP */ }
  }

  // Fall back to TCP
  try {
    return await sendVia(
      { hostname: TCP_HOST, port: TCP_PORT },
      message,
      timeoutSec,
    );
  } catch {
    throw new Error(
      `failed to connect to agent (tried socket ${SOCK} and TCP ${TCP_HOST}:${TCP_PORT})`
    );
  }
}

export function checkResponse(response: Response): asserts response is OkResponse {
  if (response.ok !== true) {
    fail(response.error);
  }
}

export function getStringField(response: Response, key: string): string {
  if (!response.ok) return "";
  const val = response[key];
  return typeof val === "string" ? val : "";
}
