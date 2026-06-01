import { assertEquals } from "jsr:@std/assert";
import { formatErrorMessage, getStringField, isRemoteSession } from "./oa.ts";
import type { OkResponse } from "./messages.ts";

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

const SSH_VARS = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"] as const;

// Save the three SSH vars, clear them, run body, then restore. Keeps the
// real test environment (which may itself be an SSH session) from leaking
// into these assertions.
function withSshEnv(set: Partial<Record<typeof SSH_VARS[number], string>>, body: () => void): void {
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
  withSshEnv({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }, () =>
    assertEquals(isRemoteSession(), true));
});

Deno.test("isRemoteSession: true when SSH_TTY set", () => {
  withSshEnv({ SSH_TTY: "/dev/ttys001" }, () =>
    assertEquals(isRemoteSession(), true));
});

Deno.test("isRemoteSession: true when SSH_CLIENT set", () => {
  withSshEnv({ SSH_CLIENT: "1.2.3.4 22 22" }, () =>
    assertEquals(isRemoteSession(), true));
});

Deno.test("isRemoteSession: true when several SSH vars set", () => {
  withSshEnv({ SSH_CONNECTION: "x", SSH_TTY: "y" }, () =>
    assertEquals(isRemoteSession(), true));
});
