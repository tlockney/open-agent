import { assertEquals, assertRejects } from "jsr:@std/assert";
import { MountManager, type MountDeps } from "./mount_manager.ts";

const encoder = new TextEncoder();

/** Recorded command invocation. */
interface CommandCall {
  cmd: string;
  args: string[];
}

/** Create fake deps with configurable behavior. */
function createFakeDeps(opts?: {
  mountOutput?: string;
  statSuccess?: boolean;
  sshfsSuccess?: boolean;
  sshfsStderr?: string;
  umountSuccess?: boolean;
}): { deps: MountDeps; calls: CommandCall[]; logs: string[]; timers: Map<number, () => void> } {
  const calls: CommandCall[] = [];
  const logs: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;

  const deps: MountDeps = {
    async runCommand(cmd, args, _opts) {
      calls.push({ cmd, args });
      if (cmd === "mount") {
        return {
          success: true,
          stdout: encoder.encode(opts?.mountOutput ?? ""),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "stat") {
        return {
          success: opts?.statSuccess ?? true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "sshfs") {
        return {
          success: opts?.sshfsSuccess ?? true,
          stdout: new Uint8Array(),
          stderr: encoder.encode(opts?.sshfsStderr ?? ""),
        };
      }
      if (cmd === "umount") {
        return {
          success: opts?.umountSuccess ?? true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "diskutil") {
        return { success: true, stdout: new Uint8Array(), stderr: new Uint8Array() };
      }
      return { success: true, stdout: new Uint8Array(), stderr: new Uint8Array() };
    },
    async mkdir(_path, _opts) { /* no-op */ },
    log(msg) { logs.push(msg); },
    setTimeout(fn, _ms) {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };

  return { deps, calls, logs, timers };
}

Deno.test("ensureMount: creates a new mount via sshfs", async () => {
  const { deps, calls } = createFakeDeps({ sshfsSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000);

  const state = await mgr.ensureMount("h1", "/home/user");
  assertEquals(state.host, "h1");
  assertEquals(state.remoteHome, "/home/user");
  assertEquals(state.mountPoint, "/mnt/h1");

  const sshfsCalls = calls.filter((c) => c.cmd === "sshfs");
  assertEquals(sshfsCalls.length, 1);
  assertEquals(sshfsCalls[0].args[0], "h1:/home/user");
  assertEquals(sshfsCalls[0].args[1], "/mnt/h1");
});

Deno.test("ensureMount: reuses existing responsive mount", async () => {
  const { deps, calls } = createFakeDeps({
    sshfsSuccess: true,
    mountOutput: "/mnt/h1",
    statSuccess: true,
  });
  const mgr = new MountManager(deps, "/mnt", 30000);

  // First mount
  await mgr.ensureMount("h1", "/home/user");
  const sshfsCount1 = calls.filter((c) => c.cmd === "sshfs").length;
  assertEquals(sshfsCount1, 1);

  // Second mount — should reuse (mount is responsive)
  await mgr.ensureMount("h1", "/home/user");
  const sshfsCount2 = calls.filter((c) => c.cmd === "sshfs").length;
  assertEquals(sshfsCount2, 1); // No additional sshfs call
});

Deno.test("ensureMount: remounts when existing mount is stale", async () => {
  let mountOutput = "";
  const calls: CommandCall[] = [];

  const deps: MountDeps = {
    async runCommand(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === "mount") {
        return { success: true, stdout: encoder.encode(mountOutput), stderr: new Uint8Array() };
      }
      if (cmd === "sshfs") {
        return { success: true, stdout: new Uint8Array(), stderr: new Uint8Array() };
      }
      // umount, diskutil, stat
      return { success: cmd === "umount", stdout: new Uint8Array(), stderr: new Uint8Array() };
    },
    async mkdir() {},
    log() {},
    setTimeout(fn, _ms) { return 0; },
    clearTimeout() {},
  };

  const mgr = new MountManager(deps, "/mnt", 30000);

  // First mount
  await mgr.ensureMount("h1", "/home/user");
  const sshfsCount1 = calls.filter((c) => c.cmd === "sshfs").length;
  assertEquals(sshfsCount1, 1);

  // Mount is now stale (mount command doesn't show it)
  mountOutput = ""; // mount point not in mount table
  await mgr.ensureMount("h1", "/home/user");
  const sshfsCount2 = calls.filter((c) => c.cmd === "sshfs").length;
  assertEquals(sshfsCount2, 2); // Remounted
});

Deno.test("ensureMount: concurrent calls are serialized", async () => {
  let sshfsCallCount = 0;
  let concurrentSshfs = 0;
  let maxConcurrentSshfs = 0;

  const deps: MountDeps = {
    async runCommand(cmd) {
      if (cmd === "sshfs") {
        sshfsCallCount++;
        concurrentSshfs++;
        maxConcurrentSshfs = Math.max(maxConcurrentSshfs, concurrentSshfs);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        concurrentSshfs--;
        return { success: true, stdout: new Uint8Array(), stderr: new Uint8Array() };
      }
      if (cmd === "mount") {
        return { success: true, stdout: new Uint8Array(), stderr: new Uint8Array() };
      }
      return { success: true, stdout: new Uint8Array(), stderr: new Uint8Array() };
    },
    async mkdir() {},
    log() {},
    setTimeout(fn, _ms) { return 0; },
    clearTimeout() {},
  };

  const mgr = new MountManager(deps, "/mnt", 30000);

  // Launch 3 concurrent mounts for the same host
  await Promise.all([
    mgr.ensureMount("h1", "/home/user"),
    mgr.ensureMount("h1", "/home/user"),
    mgr.ensureMount("h1", "/home/user"),
  ]);

  // All should have run (each needs its own sshfs since mount table is empty),
  // but never concurrently
  assertEquals(maxConcurrentSshfs, 1);
});

Deno.test("ensureMount: sshfs failure throws", async () => {
  const { deps } = createFakeDeps({ sshfsSuccess: false, sshfsStderr: "connection refused" });
  const mgr = new MountManager(deps, "/mnt", 30000);

  await assertRejects(
    () => mgr.ensureMount("h1", "/home/user"),
    Error,
    "sshfs mount failed: connection refused",
  );
});

Deno.test("scheduleUnmount: fires after timer and unmounts", async () => {
  const { deps, calls, timers } = createFakeDeps({ sshfsSuccess: true, umountSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000);

  const state = await mgr.ensureMount("h1", "/home/user");
  // No sessions — schedule unmount
  mgr.scheduleUnmount("h1");
  assertEquals(timers.size, 1);

  // Verify mount exists before timer fires
  assertEquals(mgr.getMount("h1"), state);

  // Fire the timer
  const timerFn = [...timers.values()][0];
  timerFn();
  // Give the async unmount time to complete
  await new Promise((r) => setTimeout(r, 10));

  // Mount should be gone
  assertEquals(mgr.getMount("h1"), undefined);
  const umountCalls = calls.filter((c) => c.cmd === "umount");
  assertEquals(umountCalls.length >= 1, true);
});

Deno.test("scheduleUnmount: cancelled when new session connects", async () => {
  const { deps, timers } = createFakeDeps({
    sshfsSuccess: true,
    mountOutput: "/mnt/h1",
    statSuccess: true,
  });
  const mgr = new MountManager(deps, "/mnt", 30000);

  await mgr.ensureMount("h1", "/home/user");
  mgr.scheduleUnmount("h1");
  assertEquals(timers.size, 1);

  // New session connects — ensureMount cancels the timer
  await mgr.ensureMount("h1", "/home/user");
  assertEquals(timers.size, 0); // Timer was cleared
});

Deno.test("forceUnmount: falls back to diskutil when umount fails", async () => {
  const { deps, calls } = createFakeDeps({ sshfsSuccess: true, umountSuccess: false });
  const mgr = new MountManager(deps, "/mnt", 30000);

  await mgr.ensureMount("h1", "/home/user");
  await mgr.unmountHost("h1");

  const umountCalls = calls.filter((c) => c.cmd === "umount");
  const diskutilCalls = calls.filter((c) => c.cmd === "diskutil");
  assertEquals(umountCalls.length, 1);
  assertEquals(diskutilCalls.length, 1);
  assertEquals(diskutilCalls[0].args, ["unmount", "force", "/mnt/h1"]);
});

Deno.test("unmountAll: unmounts all hosts", async () => {
  const { deps, calls } = createFakeDeps({ sshfsSuccess: true, umountSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000);

  await mgr.ensureMount("h1", "/home/user1");
  await mgr.ensureMount("h2", "/home/user2");
  assertEquals(mgr.getAllMounts().size, 2);

  await mgr.unmountAll();
  assertEquals(mgr.getAllMounts().size, 0);
  const umountCalls = calls.filter((c) => c.cmd === "umount");
  assertEquals(umountCalls.length, 2);
});

Deno.test("isMounted: checks mount output", async () => {
  const { deps } = createFakeDeps({ mountOutput: "/mnt/h1 on /dev/fuse0" });
  const mgr = new MountManager(deps, "/mnt", 30000);

  assertEquals(await mgr.isMounted("/mnt/h1"), true);
  assertEquals(await mgr.isMounted("/mnt/h2"), false);
});

Deno.test("isMountResponsive: false when not mounted", async () => {
  const { deps } = createFakeDeps({ mountOutput: "" });
  const mgr = new MountManager(deps, "/mnt", 30000);

  assertEquals(await mgr.isMountResponsive("/mnt/h1"), false);
});

Deno.test("isMountResponsive: false when stat fails", async () => {
  const { deps } = createFakeDeps({ mountOutput: "/mnt/h1", statSuccess: false });
  const mgr = new MountManager(deps, "/mnt", 30000);

  assertEquals(await mgr.isMountResponsive("/mnt/h1"), false);
});

Deno.test("isMountResponsive: true when mounted and stat succeeds", async () => {
  const { deps } = createFakeDeps({ mountOutput: "/mnt/h1", statSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000);

  assertEquals(await mgr.isMountResponsive("/mnt/h1"), true);
});

Deno.test("session tracking via mount state", async () => {
  const { deps } = createFakeDeps({ sshfsSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000);

  const state = await mgr.ensureMount("h1", "/home/user");
  state.sessions.add("s1");
  state.sessions.add("s2");
  assertEquals(state.sessions.size, 2);

  state.sessions.delete("s1");
  assertEquals(state.sessions.size, 1);
  assertEquals(state.sessions.has("s2"), true);
});
