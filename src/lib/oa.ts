// oa.ts — Shared utilities for remote-side scripts that communicate
// with the open-agent daemon via Unix socket or TCP fallback.
//
// Usage:
//   import { send, requireSock, fail, SOCK, HOST, HOME } from "./lib/oa.ts";

import { existsSync } from "jsr:@std/fs@1/exists";
import type { ErrorObject, Message, OkResponse, Response } from "./messages.ts";

export const HOME = Deno.env.get("HOME") ?? "";

/** Where sshd's RemoteForward lands the tunnelled socket on a remote host. */
export const FORWARDED_SOCK = "/tmp/open-agent.sock";

/**
 * The socket to talk to the daemon on.
 *
 * On a remote we reach the daemon only through the SSH tunnel, which binds
 * FORWARDED_SOCK. Locally the daemon binds its own socket under ~/.local/share
 * and never listens on /tmp — a /tmp socket on the local Mac is at best a
 * leftover from an inbound forward, so connecting to it fails even though the
 * file exists.
 */
export function defaultSockPath(home: string, remote: boolean): string {
  return remote
    ? FORWARDED_SOCK
    : `${home}/.local/share/open-agent/open-agent.sock`;
}

export const SOCK = Deno.env.get("OPEN_AGENT_SOCK") ??
  defaultSockPath(HOME, isRemoteSession());
export const TCP_HOST = Deno.env.get("OPEN_AGENT_TCP_HOST") ?? "127.0.0.1";
export const TCP_PORT = parseInt(
  Deno.env.get("OPEN_AGENT_TCP_PORT") ?? "19876",
  10,
);

/**
 * Whether the TCP fallback is safe to try.
 *
 * The SSH config forwards the Unix socket, not the TCP port. So inside a
 * remote session, 127.0.0.1:19876 is not the personal Mac — it is whatever
 * daemon happens to run on *this* machine. On a remote that also runs a
 * daemon of its own, falling back to it silently serves the request on the
 * wrong machine: `ropen` opens the file here, `rcopy` writes to this
 * clipboard, and the command exits 0 as if it had worked.
 *
 * So on a remote the fallback is opt-in: set OPEN_AGENT_TCP_HOST or
 * OPEN_AGENT_TCP_PORT to say "I really did forward a TCP port to the daemon".
 * Locally there is no ambiguity — loopback is our own daemon, which is the
 * one we want.
 */
export function shouldTryTcp(remote: boolean, tcpConfigured: boolean): boolean {
  return !remote || tcpConfigured;
}

const TCP_CONFIGURED = Boolean(
  Deno.env.get("OPEN_AGENT_TCP_HOST") ?? Deno.env.get("OPEN_AGENT_TCP_PORT"),
);
// Resolve host identity: env var → identity file → hostname fallback
function resolveHost(): string {
  const envHost = Deno.env.get("OPEN_AGENT_HOST");
  if (envHost) return envHost;

  const identityPath = `${
    Deno.env.get("HOME") ?? ""
  }/.config/open-agent/identity`;
  try {
    return Deno.readTextFileSync(identityPath).trim();
  } catch { /* file doesn't exist */ }

  return "unknown";
}
export const HOST = resolveHost();

/**
 * True when running inside an SSH session — i.e. on the remote machine,
 * where the r* commands should reach back to the local agent. False means
 * we're sitting at the local Mac and should run the native equivalent.
 */
export function isRemoteSession(): boolean {
  return Boolean(
    Deno.env.get("SSH_CONNECTION") ||
      Deno.env.get("SSH_TTY") ||
      Deno.env.get("SSH_CLIENT"),
  );
}

export const SCRIPT_NAME =
  new URL(import.meta.url).pathname.split("/").at(-2) ?? "oa";

export function fail(msg: string): never {
  console.error(`${callerName()}: ${msg}`);
  Deno.exit(1);
}

// Derive the calling script name from the main module, not this library
function callerName(): string {
  try {
    const main = Deno.mainModule;
    return new URL(main).pathname.split("/").pop()?.replace(/\.ts$/, "") ??
      "oa";
  } catch {
    return "oa";
  }
}

export function requireSock(): void {
  if (!existsSync(SOCK)) {
    // Socket missing — TCP may still work, so just warn
    const next = shouldTryTcp(isRemoteSession(), TCP_CONFIGURED)
      ? `will try TCP ${TCP_HOST}:${TCP_PORT}`
      : `no TCP fallback on a remote (it would be this machine's own daemon)`;
    console.error(`${callerName()}: socket not found at ${SOCK}, ${next}`);
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
      (conn) => {
        clearTimeout(timer);
        resolve(conn);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
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
    return JSON.parse(
      new TextDecoder().decode(buf.subarray(0, n)).trim(),
    ) as Response;
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function send(
  message: Message,
  timeoutSec = 10,
): Promise<Response> {
  // Each transport reports why it failed. Collapsing them into one generic
  // message hid the real causes — a dead daemon, a missing Deno permission —
  // behind a blanket "the SSH tunnel died" guess.
  const failures: string[] = [];

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
    } catch (e) {
      failures.push(`socket ${SOCK}: ${describe(e)}`);
    }
  } else {
    failures.push(`socket ${SOCK}: not found`);
  }

  // Fall back to TCP — but never onto this machine's own daemon (see
  // shouldTryTcp). Serving the request on the wrong host is worse than failing.
  if (!shouldTryTcp(isRemoteSession(), TCP_CONFIGURED)) {
    throw new Error(
      `failed to connect to agent\n${
        failures.map((f) => `     - ${f}`).join("\n")
      }\n     - TCP ${TCP_HOST}:${TCP_PORT}: skipped — on a remote this would be` +
        ` this machine's own daemon, not the one across the tunnel.\n` +
        `       (set OPEN_AGENT_TCP_HOST/PORT if you really did forward it)`,
    );
  }

  try {
    return await sendVia(
      { hostname: TCP_HOST, port: TCP_PORT },
      message,
      timeoutSec,
    );
  } catch (e) {
    failures.push(`TCP ${TCP_HOST}:${TCP_PORT}: ${describe(e)}`);
    throw new Error(
      `failed to connect to agent\n${
        failures.map((f) => `     - ${f}`).join("\n")
      }`,
    );
  }
}

/**
 * Render a structured error for terminal output. Tolerates the legacy
 * string shape so a CLI built against the new format still displays
 * something reasonable when talking to an older daemon.
 */
export function formatErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const e = err as ErrorObject;
    return e.recovery ? `${e.message}\n  → recovery: ${e.recovery}` : e.message;
  }
  return "unknown error";
}

export function checkResponse(
  response: Response,
): asserts response is OkResponse {
  if (response.ok !== true) {
    fail(formatErrorMessage(response.error));
  }
}

export function getStringField(response: Response, key: string): string {
  if (!response.ok) return "";
  const val = response[key];
  return typeof val === "string" ? val : "";
}
