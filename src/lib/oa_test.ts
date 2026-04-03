import { assertEquals } from "jsr:@std/assert";
import { getStringField } from "./oa.ts";
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
  assertEquals(getStringField({ ok: false, error: "fail" }, "value"), "");
});

Deno.test("getStringField: returns empty string for null value", () => {
  const response: OkResponse = { ok: true, data: null };
  assertEquals(getStringField(response, "data"), "");
});
