import { assertEquals } from "jsr:@std/assert";
import { formatErrorMessage, getStringField } from "./oa.ts";
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
