import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  defaultSockPath,
  formatErrorMessage,
  FORWARDED_SOCK,
  getStringField,
  isLoopbackHost,
  isRemoteSession,
  parseDaemonAddress,
  resolveHostIdentity,
  resolveRemoteRole,
  send,
  shouldTryTcp,
  UNRESOLVED_HOST,
} from "./oa.ts";
import type { OkResponse } from "./messages.ts";
import { MAX_MESSAGE_BYTES } from "./framing.ts";

// --- resolveHostIdentity ---
//
// The hook (open-agent-hook.sh) resolves identity with the same precedence.
// If these two ever diverge again, the hook registers a session under one
// host key while the r* commands send another, and mounts never line up.

Deno.test("resolveHostIdentity: env var wins over the identity file", () => {
  assertEquals(resolveHostIdentity("fromenv", "fromfile"), "fromenv");
});

Deno.test("resolveHostIdentity: falls back to the identity file", () => {
  assertEquals(resolveHostIdentity(undefined, "workmbp"), "workmbp");
});

Deno.test("resolveHostIdentity: trims surrounding whitespace", () => {
  assertEquals(resolveHostIdentity(undefined, "  workmbp\n"), "workmbp");
  assertEquals(resolveHostIdentity("  workmbp \n", undefined), "workmbp");
});

Deno.test("resolveHostIdentity: blank sources count as absent", () => {
  // An empty identity file must not register a session under "".
  assertEquals(resolveHostIdentity("", ""), UNRESOLVED_HOST);
  assertEquals(resolveHostIdentity("   ", "\n\t "), UNRESOLVED_HOST);
  assertEquals(resolveHostIdentity(undefined, undefined), UNRESOLVED_HOST);
});

Deno.test("resolveHostIdentity: skips a blank env var for a real file", () => {
  assertEquals(resolveHostIdentity("  ", "workmbp"), "workmbp");
});

// --- send() size guard ---

Deno.test("send: refuses an over-cap message before opening a connection", async () => {
  // The guard runs before any I/O, so this needs no daemon and no net
  // permission. Without it the daemon closes mid-upload and the caller
  // reports "Broken pipe", which explains nothing.
  await assertRejects(
    () =>
      send({
        action: "copy",
        content: "x".repeat(MAX_MESSAGE_BYTES + 1_000),
      }),
    Error,
    "over the",
  );
});

Deno.test("resolveHostIdentity: never guesses from the system hostname", () => {
  // Deliberate: the value is used verbatim as an SSH destination, so a
  // guess mounts the wrong host instead of failing.
  const resolved = resolveHostIdentity(undefined, undefined);
  assertEquals(resolved, UNRESOLVED_HOST);
  assertEquals(resolved, "unknown");
});

// --- getStringField ---

Deno.test("getStringField: returns string value", () => {
  const response: OkResponse = { ok: true, name: "alice" };
  assertEquals(getStringField(response, "name"), "alice");
});

Deno.test("getStringField: returns empty string for missing key", () => {
  const response: OkResponse = { ok: true };
  assertEquals(getStringField(response, "missing"), "");
});

Deno.test("getStringField: returns empty string for non-string value", () => {
  const response: OkResponse = { ok: true, count: 42 };
  assertEquals(getStringField(response, "count"), "");
});

Deno.test("getStringField: returns empty string for error response", () => {
  assertEquals(
    getStringField(
      { ok: false, error: { code: "internal", message: "fail" } },
      "value",
    ),
    "",
  );
});

Deno.test("getStringField: returns empty string for null value", () => {
  const response: OkResponse = { ok: true, data: null };
  assertEquals(getStringField(response, "data"), "");
});

// --- formatErrorMessage ---

Deno.test("formatErrorMessage: structured error without recovery", () => {
  const out = formatErrorMessage({ code: "internal", message: "boom" });
  assertEquals(out, "boom");
});

Deno.test("formatErrorMessage: structured error appends recovery hint", () => {
  const out = formatErrorMessage({
    code: "mount_stale",
    message: "mount unresponsive",
    recovery: "ra reset workmbp",
  });
  assertEquals(out, "mount unresponsive\n  → recovery: ra reset workmbp");
});

Deno.test("formatErrorMessage: tolerates legacy string shape", () => {
  // Older daemons may still return error as a plain string.
  assertEquals(formatErrorMessage("legacy error"), "legacy error");
});

Deno.test("formatErrorMessage: returns 'unknown error' for unrecognized shapes", () => {
  assertEquals(formatErrorMessage(undefined), "unknown error");
  assertEquals(formatErrorMessage({ unrelated: "field" }), "unknown error");
});

// --- isRemoteSession ---

const SSH_VARS = [
  "SSH_CONNECTION",
  "SSH_TTY",
  "SSH_CLIENT",
  // Not SSH, but they also feed the remote decision, so a test run from a
  // Rex terminal or with an override set must not leak them in either.
  "OPEN_AGENT_REMOTE",
  "REX_SESSION",
] as const;

// Save the role-deciding vars, clear them, run body, then restore. Keeps the
// real test environment (which may itself be an SSH session) from leaking
// into these assertions.
function withSshEnv(
  set: Partial<Record<typeof SSH_VARS[number], string>>,
  body: () => void,
): void {
  const saved = SSH_VARS.map((v) => [v, Deno.env.get(v)] as const);
  for (const v of SSH_VARS) Deno.env.delete(v);
  for (const [k, val] of Object.entries(set)) Deno.env.set(k, val);
  try {
    body();
  } finally {
    for (const [v, val] of saved) {
      if (val === undefined) Deno.env.delete(v);
      else Deno.env.set(v, val);
    }
  }
}

Deno.test("isRemoteSession: false when no SSH vars set", () => {
  withSshEnv({}, () => assertEquals(isRemoteSession(), false));
});

Deno.test("isRemoteSession: true when SSH_CONNECTION set", () => {
  withSshEnv(
    { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
    () => assertEquals(isRemoteSession(), true),
  );
});

Deno.test("isRemoteSession: true when SSH_TTY set", () => {
  withSshEnv(
    { SSH_TTY: "/dev/ttys001" },
    () => assertEquals(isRemoteSession(), true),
  );
});

Deno.test("isRemoteSession: true when SSH_CLIENT set", () => {
  withSshEnv(
    { SSH_CLIENT: "1.2.3.4 22 22" },
    () => assertEquals(isRemoteSession(), true),
  );
});

Deno.test("isRemoteSession: true when several SSH vars set", () => {
  withSshEnv(
    { SSH_CONNECTION: "x", SSH_TTY: "y" },
    () => assertEquals(isRemoteSession(), true),
  );
});

// --- defaultSockPath ---

Deno.test("defaultSockPath: remote uses the SSH-forwarded socket", () => {
  assertEquals(defaultSockPath("/home/thomas", true), FORWARDED_SOCK);
});

// --- shouldTryTcp ---

// A remote that also runs a daemon of its own (a work Mac that is both host
// and remote) would otherwise have the fallback serve requests against
// itself: ropen opens the file on the wrong machine and exits 0.
Deno.test("shouldTryTcp: never falls back to loopback on a remote by default", () => {
  assertEquals(shouldTryTcp(true, false), false);
});

Deno.test("shouldTryTcp: remote may opt in by configuring TCP explicitly", () => {
  assertEquals(shouldTryTcp(true, true), true);
});

Deno.test("shouldTryTcp: local always tries TCP — loopback is our own daemon", () => {
  assertEquals(shouldTryTcp(false, false), true);
  assertEquals(shouldTryTcp(false, true), true);
});

Deno.test("defaultSockPath: local uses the daemon's own socket, not /tmp", () => {
  // The daemon binds ~/.local/share/open-agent/open-agent.sock and never
  // listens on /tmp. Defaulting to /tmp locally meant the CLI could only ever
  // reach the daemon over the TCP fallback.
  assertEquals(
    defaultSockPath("/Users/thomas", false),
    "/Users/thomas/.local/share/open-agent/open-agent.sock",
  );
});

// --- isLoopbackHost ---

Deno.test("isLoopbackHost: loopback names are local", () => {
  assertEquals(isLoopbackHost("127.0.0.1"), true);
  assertEquals(isLoopbackHost("::1"), true);
  assertEquals(isLoopbackHost("localhost"), true);
});

Deno.test("isLoopbackHost: non-loopback hosts are not local", () => {
  assertEquals(isLoopbackHost("10.0.0.5"), false);
  assertEquals(isLoopbackHost("macbook.tailnet.ts.net"), false);
});

// --- resolveRemoteRole ---

const role = (
  over: Partial<Parameters<typeof resolveRemoteRole>[0]>,
): boolean =>
  resolveRemoteRole({ ssh: false, rex: false, directDaemon: false, ...over });

Deno.test("resolveRemoteRole: SSH session is remote", () => {
  assertEquals(role({ ssh: true }), true);
});

Deno.test("resolveRemoteRole: plain local shell is local", () => {
  assertEquals(role({}), false);
});

// A Rex server's shells are not children of sshd, so they carry no SSH vars
// even when the person is on another machine. With a direct daemon
// configured they must count as remote, or rcopy writes to this machine's
// clipboard and exits 0.
Deno.test("resolveRemoteRole: Rex shell with a direct daemon is remote", () => {
  assertEquals(role({ rex: true, directDaemon: true }), true);
});

// The same Rex server also hosts shells for someone at this machine's own
// keyboard; without a daemon elsewhere there is nothing to reach back to.
Deno.test("resolveRemoteRole: Rex shell without a direct daemon is local", () => {
  assertEquals(role({ rex: true }), false);
});

// A daemon address alone (no SSH, no Rex) keeps the old behaviour: a shell
// at this machine's own keyboard still runs the native commands.
Deno.test("resolveRemoteRole: direct daemon outside Rex is local", () => {
  assertEquals(role({ directDaemon: true }), false);
});

Deno.test("resolveRemoteRole: OPEN_AGENT_REMOTE=1 forces remote", () => {
  for (const v of ["1", "true", "YES", " yes "]) {
    assertEquals(role({ override: v }), true, v);
  }
});

Deno.test("resolveRemoteRole: OPEN_AGENT_REMOTE=0 forces local, even over SSH", () => {
  for (const v of ["0", "false", "No"]) {
    assertEquals(role({ override: v, ssh: true }), false, v);
  }
});

Deno.test("resolveRemoteRole: unrecognised override is ignored", () => {
  assertEquals(role({ override: "maybe", ssh: true }), true);
  assertEquals(role({ override: "", rex: true }), false);
});

Deno.test("isRemoteSession: OPEN_AGENT_REMOTE=1 without SSH is remote", () => {
  withSshEnv(
    { OPEN_AGENT_REMOTE: "1" },
    () => assertEquals(isRemoteSession(), true),
  );
});

Deno.test("isRemoteSession: OPEN_AGENT_REMOTE=0 overrides SSH", () => {
  withSshEnv(
    { OPEN_AGENT_REMOTE: "0", SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
    () => assertEquals(isRemoteSession(), false),
  );
});

// --- parseDaemonAddress ---

Deno.test("parseDaemonAddress: bare host", () => {
  assertEquals(parseDaemonAddress("macbook.tailnet.ts.net\n"), {
    host: "macbook.tailnet.ts.net",
  });
});

Deno.test("parseDaemonAddress: host and port", () => {
  assertEquals(parseDaemonAddress("100.64.0.7:20000"), {
    host: "100.64.0.7",
    port: 20000,
  });
});

Deno.test("parseDaemonAddress: bracketed IPv6 with and without port", () => {
  assertEquals(parseDaemonAddress("[fd7a:115c::7]:19876"), {
    host: "fd7a:115c::7",
    port: 19876,
  });
  assertEquals(parseDaemonAddress("[fd7a:115c::7]"), { host: "fd7a:115c::7" });
});

Deno.test("parseDaemonAddress: skips comments and blank lines", () => {
  assertEquals(
    parseDaemonAddress("# personal Mac over Tailscale\n\n  macbook  \n"),
    { host: "macbook" },
  );
});

Deno.test("parseDaemonAddress: empty or missing is undefined", () => {
  assertEquals(parseDaemonAddress(undefined), undefined);
  assertEquals(parseDaemonAddress(""), undefined);
  assertEquals(parseDaemonAddress("# only a comment\n"), undefined);
});

// A typo must fall back to the defaults, not send requests somewhere odd.
Deno.test("parseDaemonAddress: malformed input is undefined", () => {
  assertEquals(parseDaemonAddress("fd7a:115c::7"), undefined); // unbracketed v6
  assertEquals(parseDaemonAddress("host:port"), undefined);
  assertEquals(parseDaemonAddress("host:0"), undefined);
  assertEquals(parseDaemonAddress("host:70000"), undefined);
  assertEquals(parseDaemonAddress("two words"), undefined);
});
