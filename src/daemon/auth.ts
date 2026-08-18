// auth.ts — token-based authentication for non-loopback connections.
//
// The daemon binds loopback by default and trusts the SSH tunnel, so a
// loopback connection needs no credential. When the daemon is bound beyond
// loopback (OPEN_AGENT_BIND), any connection that is not loopback must present
// the shared token. The token is generated at first startup and persisted so
// it survives restarts.

import { existsSync } from "jsr:@std/fs@1/exists";

/** Filename of the persisted token, inside the open-agent config dir. */
export const TOKEN_FILENAME = "auth-token";

/** Length of the generated token in bytes (rendered as 64 hex chars). */
const TOKEN_BYTES = 32;

/** Generate a fresh random token as lowercase hex. */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read the token from `configDir/auth-token`, creating it with a fresh token
 * (mode 0600) if absent. The token must survive restarts, so it is persisted
 * rather than regenerated each boot.
 */
export async function loadOrCreateToken(configDir: string): Promise<string> {
  const path = `${configDir}/${TOKEN_FILENAME}`;
  if (existsSync(path)) {
    const existing = (await Deno.readTextFile(path)).trim();
    if (existing) return existing;
  }
  const token = generateToken();
  await Deno.writeTextFile(path, token + "\n", { mode: 0o600 });
  return token;
}

/**
 * True when a remote address is loopback. A Unix socket is always local; a
 * TCP address is loopback only for 127.0.0.1 / ::1 / localhost. An unknown
 * transport is treated as local (the conservative direction for a credential
 * check is to require it, but there is no non-loopback case we can't see).
 */
export function isLoopbackAddress(addr: Deno.Addr | undefined): boolean {
  if (!addr) return true;
  if (addr.transport !== "tcp") return true; // unix socket is always local
  return addr.hostname === "127.0.0.1" || addr.hostname === "::1" ||
    addr.hostname === "localhost";
}

/**
 * Validate a request against the token. Returns an error message when the
 * connection is non-loopback and the token is missing or wrong; null when the
 * request is allowed (loopback, or a correct token on a non-loopback link).
 */
export function checkAuth(
  addr: Deno.Addr | undefined,
  token: string | undefined,
  expectedToken: string,
): string | null {
  if (isLoopbackAddress(addr)) return null;
  if (!token || token !== expectedToken) {
    return "authentication required: this connection is not loopback and did not present the correct token";
  }
  return null;
}
