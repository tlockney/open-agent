// oa.ts — Shared utilities for remote-side scripts that communicate
// with the open-agent daemon via Unix socket or TCP fallback.
//
// Usage:
//   import { send, requireSock, fail, SOCK, HOST, HOME } from "./lib/oa.ts";

import { existsSync } from "jsr:@std/fs@1/exists";
import type { ErrorObject, Message, OkResponse, Response } from "./messages.ts";
import { MAX_MESSAGE_BYTES, readMessage, writeMessage } from "./framing.ts";

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

/** Port the daemon's TCP listener uses unless told otherwise. */
export const DEFAULT_TCP_PORT = 19876;

/** A daemon address read from the `daemon-address` config file. */
export interface DaemonAddress {
  host: string;
  port?: number;
}

/**
 * Parse the `daemon-address` file: `host` or `host:port`, with an IPv6
 * literal written in brackets (`[fd7a::1]:19876`). Blank lines and `#`
 * comments are ignored; the first remaining line wins. Returns undefined for
 * an empty or malformed file so a typo falls back to the defaults instead of
 * sending requests somewhere unintended.
 */
export function parseDaemonAddress(
  contents: string | undefined,
): DaemonAddress | undefined {
  const line = contents?.split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) return undefined;

  const match = line.match(/^\[([^\]]+)\](?::(\d+))?$/) ??
    line.match(/^([^:\s\[\]]+)(?::(\d+))?$/);
  if (!match) return undefined;

  const host = match[1];
  if (match[2] === undefined) return { host };
  const port = parseInt(match[2], 10);
  if (port < 1 || port > 65535) return undefined;
  return { host, port };
}

/** Where the daemon-address file lives. */
export function daemonAddressPath(home: string): string {
  return `${home}/.config/open-agent/daemon-address`;
}

function readDaemonAddress(): DaemonAddress | undefined {
  try {
    return parseDaemonAddress(Deno.readTextFileSync(daemonAddressPath(HOME)));
  } catch {
    return undefined; // no file
  }
}

/**
 * A daemon this machine was told to reach directly, from the
 * `daemon-address` file. Env vars still take precedence over it below.
 */
const DAEMON_ADDRESS = readDaemonAddress();

export const TCP_HOST = Deno.env.get("OPEN_AGENT_TCP_HOST") ??
  DAEMON_ADDRESS?.host ?? "127.0.0.1";
export const TCP_PORT = parseInt(
  Deno.env.get("OPEN_AGENT_TCP_PORT") ??
    String(DAEMON_ADDRESS?.port ?? DEFAULT_TCP_PORT),
  10,
);

/**
 * Whether a daemon on another machine is configured for direct connection —
 * a non-loopback TCP host from OPEN_AGENT_TCP_HOST or the daemon-address
 * file. This is what lets a shell with no SSH tunnel (a Rex terminal, say)
 * still reach the personal Mac.
 */
export const DIRECT_DAEMON = !isLoopbackHost(TCP_HOST);

export const SOCK = Deno.env.get("OPEN_AGENT_SOCK") ??
  defaultSockPath(HOME, isRemoteSession());

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
  Deno.env.get("OPEN_AGENT_TCP_HOST") ?? Deno.env.get("OPEN_AGENT_TCP_PORT") ??
    DAEMON_ADDRESS,
);
/**
 * Sentinel for "this machine has no configured identity".
 *
 * Deliberately not `hostname -s`. The identity is used verbatim as an SSH
 * destination by the daemon, so it has to match the `Host` alias on the
 * local Mac — which a remote's own hostname usually does not. Guessing
 * produces a plausible-looking mount against the wrong host (or a baffling
 * sshfs error); an explicit sentinel lets the CLIs fail with instructions.
 * `open-agent-hook.sh` resolves identity the same way and refuses to
 * register a session when it comes back unresolved.
 */
export const UNRESOLVED_HOST = "unknown";

/** Guidance shown whenever the identity cannot be resolved. */
export const HOST_IDENTITY_HELP =
  "set OPEN_AGENT_HOST, or write the name to ~/.config/open-agent/identity.\n" +
  "  It must match the SSH Host alias the local Mac uses for this machine.";

/**
 * Pure identity resolution: env var → identity file → unresolved.
 * Blank and whitespace-only values count as absent, so an empty identity
 * file cannot register a session under the empty-string host.
 */
export function resolveHostIdentity(
  envHost: string | undefined,
  identityFileContents: string | undefined,
): string {
  if (envHost?.trim()) return envHost.trim();
  if (identityFileContents?.trim()) return identityFileContents.trim();
  return UNRESOLVED_HOST;
}

function resolveHost(): string {
  const identityPath = `${
    Deno.env.get("HOME") ?? ""
  }/.config/open-agent/identity`;
  let contents: string | undefined;
  try {
    contents = Deno.readTextFileSync(identityPath);
  } catch { /* file doesn't exist */ }

  return resolveHostIdentity(Deno.env.get("OPEN_AGENT_HOST"), contents);
}
export const HOST = resolveHost();

/**
 * Return the host identity, or exit with instructions if it is unresolved.
 * Call this from any command that sends a host-bearing message — without it
 * the daemon is asked to mount a host literally named "unknown".
 */
export function requireHost(host: string = HOST): string {
  if (host === UNRESOLVED_HOST) {
    fail(
      `cannot determine this machine's identity — ${HOST_IDENTITY_HELP}`,
    );
  }
  return host;
}

/** The environment inputs that decide whether this shell is remote. */
export interface RemoteRoleInputs {
  /** OPEN_AGENT_REMOTE — an explicit override, when set. */
  override?: string;
  /** Any of SSH_CONNECTION / SSH_TTY / SSH_CLIENT is set. */
  ssh: boolean;
  /** REX_SESSION is set: the shell was started by a Rex server. */
  rex: boolean;
  /** A non-loopback daemon address is configured (see DIRECT_DAEMON). */
  directDaemon: boolean;
}

/**
 * Pure remote/local decision, in priority order:
 *
 * 1. OPEN_AGENT_REMOTE=1/0 (also true/false, yes/no) — explicit, always wins.
 * 2. An SSH session — the original signal, and still the common case.
 * 3. A Rex terminal with a direct daemon configured. Shells started by a Rex
 *    server are children of that server, not of sshd, so they carry no SSH
 *    variables even when the person typing is on another machine. Without
 *    this rule every r* command in such a shell ran its local fallback —
 *    `rcopy` wrote to the remote's own clipboard and exited 0. A Rex shell
 *    alone is not enough: the same server also runs shells for someone at
 *    this machine's own keyboard. A configured daemon on another machine is
 *    the statement that this machine's r* commands belong to that daemon.
 *
 * An unrecognised override value is ignored rather than guessed at.
 */
export function resolveRemoteRole(inputs: RemoteRoleInputs): boolean {
  const o = inputs.override?.trim().toLowerCase();
  if (o === "1" || o === "true" || o === "yes") return true;
  if (o === "0" || o === "false" || o === "no") return false;
  if (inputs.ssh) return true;
  return inputs.rex && inputs.directDaemon;
}

/**
 * True when the r* commands should reach back to the daemon on the personal
 * Mac; false means we are at that Mac and should run the native equivalent.
 * See resolveRemoteRole for the rules.
 */
export function isRemoteSession(): boolean {
  return resolveRemoteRole({
    override: Deno.env.get("OPEN_AGENT_REMOTE"),
    ssh: Boolean(
      Deno.env.get("SSH_CONNECTION") ||
        Deno.env.get("SSH_TTY") ||
        Deno.env.get("SSH_CLIENT"),
    ),
    rex: Boolean(Deno.env.get("REX_SESSION")),
    directDaemon: DIRECT_DAEMON,
  });
}

export const SCRIPT_NAME =
  new URL(import.meta.url).pathname.split("/").at(-2) ?? "oa";

/**
 * True when a TCP host is loopback. The daemon trusts loopback (the SSH-tunnel
 * path) and requires the shared token only for non-loopback connections, so a
 * client only needs to attach the token when it is talking to a non-loopback
 * host directly.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * The shared auth token, from OPEN_AGENT_TOKEN or the deployed auth-token
 * file. Undefined when none is configured — which is fine for loopback
 * connections, and the daemon will reject a non-loopback one without it.
 */
export function getToken(): string | undefined {
  const env = Deno.env.get("OPEN_AGENT_TOKEN");
  if (env?.trim()) return env.trim();
  const path = `${HOME}/.config/open-agent/auth-token`;
  try {
    const contents = Deno.readTextFileSync(path).trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}

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
  // With a direct daemon configured, TCP is the intended route and a missing
  // tunnel socket is normal (a Rex shell has none), so it is not worth a
  // warning on every command. Failures still list it if TCP fails too.
  if (!existsSync(SOCK) && !DIRECT_DAEMON) {
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
    await writeMessage(conn, JSON.stringify(message));

    // Read to the newline rather than once into a fixed buffer: a large
    // `rpaste` response arrives in several reads, and taking only the first
    // truncated it into a JSON parse error.
    const timer = setTimeout(() => conn.close(), timeoutSec * 1000);
    let raw: string;
    try {
      raw = (await readMessage(conn)).trim();
    } finally {
      clearTimeout(timer);
    }
    if (!raw) throw new Error("no response from agent");
    return JSON.parse(raw) as Response;
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
  // Check the size here rather than discovering it mid-write. The daemon
  // refuses an oversized request and closes at once — correct, but it leaves
  // the client writing into a closed socket and reporting "Broken pipe",
  // which says nothing about what actually went wrong.
  const encoded = new TextEncoder().encode(JSON.stringify(message)).length;
  if (encoded > MAX_MESSAGE_BYTES) {
    throw new Error(
      `request is ${encoded} bytes, over the ${MAX_MESSAGE_BYTES}-byte limit ` +
        `the agent accepts`,
    );
  }

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
        `       (set OPEN_AGENT_TCP_HOST/PORT if you really did forward it,\n` +
        `       or write the daemon's address to ${daemonAddressPath(HOME)})`,
    );
  }

  try {
    // A non-loopback TCP target is a direct connection to a daemon bound
    // beyond loopback, which requires the shared token. Loopback (the
    // SSH-tunnel path) is trusted and needs none.
    const tcpMessage = isLoopbackHost(TCP_HOST)
      ? message
      : { ...message, token: getToken() };
    return await sendVia(
      { hostname: TCP_HOST, port: TCP_PORT },
      tcpMessage,
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
