// protocol_test.ts — wire-protocol behaviour against a real daemon.
//
// Everything here talks to the socket directly, so it covers the framing and
// accept-loop code paths that unit tests can only approximate with fakes.
// Actions with side effects (copy, notify) and actions that mount (connect,
// open, push, pull) are deliberately never used: the suite must not touch the
// developer's clipboard or spawn sshfs at a host that does not exist.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { MAX_MESSAGE_BYTES } from "../src/lib/framing.ts";
import {
  type RunningDaemon,
  SKIP_UNLESS_INTEGRATION,
  startDaemon,
} from "./harness.ts";

// One daemon for the whole file, exposed to steps through `daemon`. Starting
// a fresh daemon per assertion cost more in process startup than the tests
// themselves, and nothing here mutates state another step depends on.
let daemon: RunningDaemon;
const steps: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => steps.push([name, fn]);

const pad = (n: number) => "P".repeat(n);

test("ping reports ok and a version", async () => {
  const res = await daemon.request({ action: "ping" });
  assertEquals(res.ok, true);
  assertEquals(res.pong, true);
  assert(typeof res.version === "string" && res.version.length > 0);
});

test("status returns the shape the CLIs actually read", async () => {
  // The `open-agent status` regression: it read a top-level `sessions` key
  // and a per-mount `path` field that the daemon has never emitted. Pin the
  // contract so a future rename breaks a test instead of a command.
  const res = await daemon.request({ action: "status" });
  assertEquals(res.ok, true);
  assert(typeof res.version === "string");
  assert(
    res.mounts !== null && typeof res.mounts === "object",
    "status must carry a `mounts` object",
  );
  assertEquals(
    res.sessions,
    undefined,
    "status has no top-level `sessions` — sessions live under mounts[host]",
  );
});

test("doctor returns version and a mounts map", async () => {
  const res = await daemon.request({ action: "doctor" });
  assertEquals(res.ok, true);
  assert(typeof res.version === "string");
  assertEquals(typeof res.mounts, "object");
});

test("reset with nothing mounted reports an empty list", async () => {
  const res = await daemon.request({ action: "reset" });
  assertEquals(res.ok, true);
  assertEquals(res.reset, []);
});

test("an unknown action is rejected, not silently accepted", async () => {
  const res = await daemon.request({ action: "nosuchaction" });
  assertEquals(res.ok, false);
  assertStringIncludes(String(res.error), "Unknown action");
});

test("malformed JSON is rejected", async () => {
  const line = await daemon.raw("{not json at all");
  assert(line !== null);
  const res = JSON.parse(line);
  assertEquals(res.ok, false);
  assertStringIncludes(String(res.error), "Bad request");
});

test("requests far past one read buffer round-trip intact", async () => {
  // Each of these truncated before framing was fixed. An unknown-action reply
  // proves the daemon parsed the whole line: a truncated one fails as invalid
  // JSON instead.
  for (const size of [40_000, 300_000, 2_000_000]) {
    const res = await daemon.request({
      action: "nosuchaction",
      pad: pad(size),
    });
    assertEquals(
      res.ok,
      false,
      `payload of ${size} bytes should reach the parser`,
    );
    assertStringIncludes(String(res.error), "Unknown action");
  }
});

test("a request split across several writes is reassembled", async () => {
  // Size is not the only trigger — TCP has no message boundaries, so even a
  // small payload can arrive in pieces.
  const line = await daemon.raw('{"action":"ping"}\n', {
    splitInto: 4,
    gapMs: 40,
  });
  assert(line !== null);
  assertEquals(JSON.parse(line).ok, true);
});

test("a request with no trailing newline is still understood", async () => {
  const line = await daemon.raw('{"action":"ping"}');
  assert(line !== null);
  assertEquals(JSON.parse(line).ok, true);
});

test("a large response is delivered whole", async () => {
  // Exercises the daemon's write path and the client's read path together.
  // A rejected op:// reference echoes the offending value back, so this
  // produces a ~1 MB reply without running `op` or touching a secret.
  const value = pad(1_000_000);
  const line = await daemon.raw(
    JSON.stringify({ action: "op-resolve", refs: { KEY: value } }),
  );
  assert(line !== null);
  assert(
    line.length > 1_000_000,
    `expected the full reply, got ${line.length} bytes`,
  );
  const res = JSON.parse(line);
  assertEquals(res.ok, false);
  assertStringIncludes(String(res.error), "not an op:// reference");
});

test("an over-cap request is refused and the daemon survives", async () => {
  const oversize = JSON.stringify({
    action: "nosuchaction",
    pad: pad(MAX_MESSAGE_BYTES + 1_000),
  });
  // The daemon replies and closes while we are still uploading, so the
  // write may fail with a broken pipe. Either way it must not hang, and
  // the refusal must be logged.
  await daemon.raw(oversize).catch(() => null);

  await new Promise((r) => setTimeout(r, 200));
  assertStringIncludes(daemon.log(), "Rejected oversized request");

  const after = await daemon.request({ action: "ping" });
  assertEquals(after.ok, true, "daemon must stay up after refusing input");
});

test("a client that connects and vanishes does not kill the listener", async () => {
  // macOS surfaces this as EINVAL from accept(). Treating it as fatal once
  // tore down the Unix listener on the first short-lived r* command.
  //
  // Deliberately well under MAX_CONSECUTIVE_ACCEPT_ERRORS (20): the daemon
  // still abandons the listener at that threshold, and with no TCP listener
  // bound that takes the whole daemon down. See §10 of the architecture doc —
  // changing that policy is a separate decision, so this asserts the
  // regression that was actually fixed rather than pinning the threshold.
  for (let i = 0; i < 10; i++) {
    const conn = await Deno.connect({
      transport: "unix",
      path: daemon.sockPath,
    });
    conn.close();
  }
  const res = await daemon.request({ action: "ping" });
  assertEquals(res.ok, true, "listener must survive abandoned connections");
});

Deno.test({
  name: "protocol",
  ignore: SKIP_UNLESS_INTEGRATION,
  async fn(t) {
    daemon = await startDaemon();
    try {
      for (const [name, body] of steps) {
        await t.step(name, body);
      }
    } finally {
      await daemon.stop();
    }
  },
});
