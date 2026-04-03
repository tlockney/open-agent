import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parseMessage } from "./messages.ts";

// --- Valid messages ---

Deno.test("parseMessage: open", () => {
  const msg = parseMessage({ action: "open", host: "h", remoteHome: "/home/u", path: "/home/u/f" });
  assertEquals(msg.action, "open");
});

Deno.test("parseMessage: open with app", () => {
  const msg = parseMessage({ action: "open", host: "h", remoteHome: "/home/u", path: "/home/u/f", app: "Marked 2" });
  assertEquals(msg.action, "open");
  if (msg.action === "open") assertEquals(msg.app, "Marked 2");
});

Deno.test("parseMessage: open-vscode", () => {
  const msg = parseMessage({ action: "open-vscode", host: "h", path: "/p" });
  assertEquals(msg.action, "open-vscode");
});

Deno.test("parseMessage: connect", () => {
  const msg = parseMessage({ action: "connect", host: "h", remoteHome: "/home/u", sessionId: "s1" });
  assertEquals(msg.action, "connect");
});

Deno.test("parseMessage: disconnect", () => {
  const msg = parseMessage({ action: "disconnect", host: "h", sessionId: "s1" });
  assertEquals(msg.action, "disconnect");
});

Deno.test("parseMessage: copy", () => {
  const msg = parseMessage({ action: "copy", content: "hello" });
  assertEquals(msg.action, "copy");
});

Deno.test("parseMessage: paste", () => {
  const msg = parseMessage({ action: "paste" });
  assertEquals(msg.action, "paste");
});

Deno.test("parseMessage: notify with all fields", () => {
  const msg = parseMessage({
    action: "notify", title: "t", message: "m", subtitle: "s", sound: "Ping",
  });
  assertEquals(msg.action, "notify");
});

Deno.test("parseMessage: notify title only", () => {
  const msg = parseMessage({ action: "notify", title: "t" });
  assertEquals(msg.action, "notify");
});

Deno.test("parseMessage: open-url", () => {
  const msg = parseMessage({ action: "open-url", url: "https://example.com" });
  assertEquals(msg.action, "open-url");
});

Deno.test("parseMessage: push", () => {
  const msg = parseMessage({ action: "push", host: "h", remoteHome: "/home/u", path: "/home/u/f" });
  assertEquals(msg.action, "push");
});

Deno.test("parseMessage: push with dest", () => {
  const msg = parseMessage({ action: "push", host: "h", remoteHome: "/home/u", path: "/home/u/f", dest: "/tmp" });
  assertEquals(msg.action, "push");
});

Deno.test("parseMessage: pull", () => {
  const msg = parseMessage({
    action: "pull", host: "h", remoteHome: "/home/u", localPath: "/l", remoteDest: "/r",
  });
  assertEquals(msg.action, "pull");
});

Deno.test("parseMessage: op-read", () => {
  const msg = parseMessage({ action: "op-read", ref: "op://vault/item/field" });
  assertEquals(msg.action, "op-read");
});

Deno.test("parseMessage: op-read with account", () => {
  const msg = parseMessage({ action: "op-read", ref: "op://vault/item/field", account: "work" });
  assertEquals(msg.action, "op-read");
});

Deno.test("parseMessage: op-resolve", () => {
  const msg = parseMessage({
    action: "op-resolve",
    refs: { DB_URL: "op://dev/db/url", API_KEY: "op://dev/api/key" },
  });
  assertEquals(msg.action, "op-resolve");
});

Deno.test("parseMessage: op-resolve with account", () => {
  const msg = parseMessage({
    action: "op-resolve",
    refs: { DB_URL: "op://dev/db/url" },
    account: "personal",
  });
  assertEquals(msg.action, "op-resolve");
});

Deno.test("parseMessage: status", () => {
  const msg = parseMessage({ action: "status" });
  assertEquals(msg.action, "status");
});

// --- Invalid messages ---

Deno.test("parseMessage: missing action", () => {
  assertThrows(() => parseMessage({}), Error, "Missing 'action' field");
});

Deno.test("parseMessage: null input", () => {
  assertThrows(() => parseMessage(null), Error, "Missing 'action' field");
});

Deno.test("parseMessage: string input", () => {
  assertThrows(() => parseMessage("hello"), Error, "Missing 'action' field");
});

Deno.test("parseMessage: unknown action", () => {
  assertThrows(() => parseMessage({ action: "unknown" }), Error, "Unknown action: unknown");
});

Deno.test("parseMessage: open missing host", () => {
  assertThrows(
    () => parseMessage({ action: "open", remoteHome: "/h", path: "/p" }),
    Error, "Missing or invalid 'host'",
  );
});

Deno.test("parseMessage: open missing path", () => {
  assertThrows(
    () => parseMessage({ action: "open", host: "h", remoteHome: "/h" }),
    Error, "Missing or invalid 'path'",
  );
});

Deno.test("parseMessage: open invalid app type", () => {
  assertThrows(
    () => parseMessage({ action: "open", host: "h", remoteHome: "/h", path: "/p", app: 123 }),
    Error, "Invalid 'app' field",
  );
});

Deno.test("parseMessage: connect missing sessionId", () => {
  assertThrows(
    () => parseMessage({ action: "connect", host: "h", remoteHome: "/h" }),
    Error, "Missing or invalid 'sessionId'",
  );
});

Deno.test("parseMessage: copy missing content", () => {
  assertThrows(
    () => parseMessage({ action: "copy" }),
    Error, "Missing or invalid 'content'",
  );
});

Deno.test("parseMessage: notify missing title", () => {
  assertThrows(
    () => parseMessage({ action: "notify" }),
    Error, "Missing or invalid 'title'",
  );
});

Deno.test("parseMessage: notify invalid message type", () => {
  assertThrows(
    () => parseMessage({ action: "notify", title: "t", message: 123 }),
    Error, "Invalid 'message' field",
  );
});

Deno.test("parseMessage: notify invalid subtitle type", () => {
  assertThrows(
    () => parseMessage({ action: "notify", title: "t", subtitle: 42 }),
    Error, "Invalid 'subtitle' field",
  );
});

Deno.test("parseMessage: notify invalid sound type", () => {
  assertThrows(
    () => parseMessage({ action: "notify", title: "t", sound: true }),
    Error, "Invalid 'sound' field",
  );
});

Deno.test("parseMessage: op-read non-op ref", () => {
  assertThrows(
    () => parseMessage({ action: "op-read", ref: "https://not-op" }),
    Error, "ref must be an op:// reference",
  );
});

Deno.test("parseMessage: op-read invalid account type", () => {
  assertThrows(
    () => parseMessage({ action: "op-read", ref: "op://v/i/f", account: 123 }),
    Error, "Invalid 'account' field",
  );
});

Deno.test("parseMessage: op-resolve missing refs", () => {
  assertThrows(
    () => parseMessage({ action: "op-resolve" }),
    Error, "Missing or invalid 'refs'",
  );
});

Deno.test("parseMessage: op-resolve refs is array", () => {
  assertThrows(
    () => parseMessage({ action: "op-resolve", refs: [] }),
    Error, "Missing or invalid 'refs'",
  );
});

Deno.test("parseMessage: op-resolve non-string ref value", () => {
  assertThrows(
    () => parseMessage({ action: "op-resolve", refs: { KEY: 123 } }),
    Error, "Invalid ref value for 'KEY'",
  );
});

Deno.test("parseMessage: op-resolve non-op ref value", () => {
  assertThrows(
    () => parseMessage({ action: "op-resolve", refs: { KEY: "not-op-ref" } }),
    Error, "'KEY' is not an op:// reference",
  );
});

Deno.test("parseMessage: push invalid dest type", () => {
  assertThrows(
    () => parseMessage({ action: "push", host: "h", remoteHome: "/h", path: "/p", dest: 123 }),
    Error, "Invalid 'dest' field",
  );
});

Deno.test("parseMessage: pull missing remoteDest", () => {
  assertThrows(
    () => parseMessage({ action: "pull", host: "h", remoteHome: "/h", localPath: "/l" }),
    Error, "Missing or invalid 'remoteDest'",
  );
});
