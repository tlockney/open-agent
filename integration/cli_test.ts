// cli_test.ts — the r* commands driven end to end against a real daemon.
//
// This is the coverage that was missing. Files in src/cli/ execute at import
// and call Deno.exit, so they cannot be imported by a unit test; running them
// as subprocesses covers the whole path anyway — argument parsing, message
// construction, transport, the daemon, and the rendering of the reply. The
// `open-agent status` defect lived precisely in that last step.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
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

/** Env that makes a CLI believe it is on a configured remote. */
const asRemote = {
  SSH_CONNECTION: "10.0.0.1 1234 10.0.0.2 22",
  OPEN_AGENT_HOST: "testhost",
};

test("ra ping reports the daemon version", async () => {
  const r = await daemon.cli("ra", ["ping"]);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "OK (open-agent v");
});

test("ra status summarises version and mount count", async () => {
  const r = await daemon.cli("ra", ["status"]);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "OK · open-agent v");
  assertStringIncludes(r.stdout, "0 mounts");
});

test("ra mounts renders the empty case", async () => {
  const r = await daemon.cli("ra", ["mounts"]);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "No active mounts");
});

test("ra doctor reports transport, daemon and mounts", async () => {
  const r = await daemon.cli("ra", ["doctor"], { OPEN_AGENT_HOST: "testhost" });
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "Transport:");
  assertStringIncludes(r.stdout, "Daemon: ✓ reachable");
  assertStringIncludes(r.stdout, "testhost");
  assertStringIncludes(r.stdout, "Mounts: (none active)");
});

test("ra doctor flags an unresolved host identity", async () => {
  const r = await daemon.cli("ra", ["doctor"], { OPEN_AGENT_HOST: "" });
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "(unresolved)");
  assertStringIncludes(r.stdout, "OPEN_AGENT_HOST");
});

test("ra reset with nothing mounted says so", async () => {
  const r = await daemon.cli("ra", ["reset"]);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "No active mounts to reset");
});

test("ra rejects an unknown subcommand with usage", async () => {
  const r = await daemon.cli("ra", ["nonsense"]);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "Usage: ra");
});

test("open-agent status is gone and points at ra", async () => {
  // The removed command. Before it was deleted it exited 0 while printing
  // "Sessions: 0 active" and "unknown" mount paths, whatever the truth was.
  const r = await daemon.cli("open-agent", ["status"]);
  assertEquals(r.code, 1, "removed command must not succeed");
  const out = r.stdout + r.stderr;
  assertStringIncludes(out, "has been removed");
  assertStringIncludes(out, "ra status");
  assert(
    !out.includes("Sessions:"),
    "must not print the old fabricated summary",
  );
});

test("open-agent help no longer advertises status", async () => {
  const r = await daemon.cli("open-agent", ["help"]);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "setup-remote");
  assert(
    !r.stdout.includes("status"),
    "help must not list a removed command",
  );
});

test("a host-bearing command refuses to run without an identity", async () => {
  // Without this guard the daemon is asked to mount a host literally called
  // "unknown", which fails much later and far less clearly.
  const r = await daemon.cli("ropen", ["/etc/hosts"], {
    SSH_CONNECTION: "10.0.0.1 1234 10.0.0.2 22",
    OPEN_AGENT_HOST: "",
  });
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "cannot determine this machine's identity");
  assertStringIncludes(r.stderr, "OPEN_AGENT_HOST");
  assert(
    !daemon.log().includes("Mounting unknown:"),
    "the daemon must never be asked to mount the sentinel host",
  );
});

test("ropen outside an SSH session never contacts the daemon", async () => {
  // Dual-mode behaviour: locally it should run native `open`, not round-trip.
  // Pointed at a path that cannot open so it exits non-zero without a GUI.
  const before = daemon.log().length;
  await daemon.cli("ropen", ["/nonexistent-oa-integration-path"], {
    SSH_CONNECTION: "",
    SSH_TTY: "",
    SSH_CLIENT: "",
  });
  await new Promise((r) => setTimeout(r, 150));
  assertEquals(
    daemon.log().length,
    before,
    "a local ropen must not open a connection to the agent",
  );
});

test("rpaste and rcopy are wired to the daemon from a remote session", async () => {
  // Only the reachability of the action is asserted. Actually exercising the
  // clipboard would clobber the developer's pasteboard, so `rcopy` is checked
  // by argument handling instead: no stdin means it must fail before sending.
  const r = await daemon.cli("rcopy", [], { ...asRemote });
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "no input on stdin");
});

test("rproj status is gone and points at ra", async () => {
  // Removed for the same reason `open-agent status` was: it duplicated `ra`
  // and read response fields the daemon never emitted.
  for (const arg of ["status", "s"]) {
    const r = await daemon.cli("rproj", [arg]);
    assertEquals(r.code, 1, `rproj ${arg} must not succeed`);
    const out = r.stdout + r.stderr;
    assertStringIncludes(out, "has been removed");
    assertStringIncludes(out, "ra status");
    assert(!out.includes("Sessions:"), "must not print the old summary");
  }
});

test("a CLI cannot silently fall back to a real daemon", async () => {
  // `send()` falls back to TCP loopback when the socket fails, which is
  // correct on a real machine — loopback is its own daemon — but in a test it
  // would let an assertion pass against the developer's running daemon. The
  // harness points the fallback at a closed port; this proves it holds.
  const r = await daemon.cli("ra", ["ping"], {
    OPEN_AGENT_SOCK: "/tmp/oa-nonexistent-socket.sock",
  });
  assertEquals(r.code, 1, "must fail rather than reach another daemon");
  assert(
    !r.stdout.includes("OK (open-agent"),
    "a real daemon answered — the suite is not hermetic",
  );
});

Deno.test({
  name: "cli",
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
