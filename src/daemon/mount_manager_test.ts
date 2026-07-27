import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type MountDeps,
  MountManager,
  parseMountPoints,
} from "./mount_manager.ts";

const STATE_PATH = "/state/mounts.json";

/** A realistic `mount(8)` line: `<device> on <path> (<options>)`. */
const mountLine = (point: string, device = "sshfs") =>
  `${device}@macfuse0 on ${point} (macfuse, nodev, nosuid, mounted by me)`;

const MOUNT_H1 = mountLine("/mnt/h1");

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
  /** Seed the fake filesystem, e.g. with a persisted mount table. */
  files?: Iterable<[string, string]>;
}): {
  deps: MountDeps;
  calls: CommandCall[];
  logs: string[];
  timers: Map<number, () => void>;
  files: Map<string, string>;
} {
  const calls: CommandCall[] = [];
  const logs: string[] = [];
  const timers = new Map<number, () => void>();
  const files = new Map<string, string>(opts?.files ?? []);
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
        return {
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      return {
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
    async mkdir(_path, _opts) {/* no-op */},
    readTextFile(path) {
      const stored = files.get(path);
      return stored === undefined
        ? Promise.reject(new Deno.errors.NotFound(path))
        : Promise.resolve(stored);
    },
    writeTextFile(path, data) {
      files.set(path, data);
      return Promise.resolve();
    },
    log(msg) {
      logs.push(msg);
    },
    setTimeout(fn, _ms) {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  return { deps, calls, logs, timers, files };
}

Deno.test("ensureMount: creates a new mount via sshfs", async () => {
  const { deps, calls } = createFakeDeps({ sshfsSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

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
    mountOutput: MOUNT_H1,
    statSuccess: true,
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

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
        return {
          success: true,
          stdout: encoder.encode(mountOutput),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "sshfs") {
        return {
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      // umount, diskutil, stat
      return {
        success: cmd === "umount",
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
    async mkdir() {},
    readTextFile: () => Promise.reject(new Deno.errors.NotFound("no state")),
    writeTextFile: () => Promise.resolve(),
    log() {},
    setTimeout(_fn, _ms) {
      return 0;
    },
    clearTimeout() {},
  };

  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

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
        return {
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "mount") {
        return {
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      return {
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
    async mkdir() {},
    readTextFile: () => Promise.reject(new Deno.errors.NotFound("no state")),
    writeTextFile: () => Promise.resolve(),
    log() {},
    setTimeout(_fn, _ms) {
      return 0;
    },
    clearTimeout() {},
  };

  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

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
  const { deps } = createFakeDeps({
    sshfsSuccess: false,
    sshfsStderr: "connection refused",
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await assertRejects(
    () => mgr.ensureMount("h1", "/home/user"),
    Error,
    "sshfs mount failed: connection refused",
  );
});

Deno.test("scheduleUnmount: fires after timer and unmounts", async () => {
  const { deps, calls, timers } = createFakeDeps({
    sshfsSuccess: true,
    umountSuccess: true,
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

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
    mountOutput: MOUNT_H1,
    statSuccess: true,
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.ensureMount("h1", "/home/user");
  mgr.scheduleUnmount("h1");
  assertEquals(timers.size, 1);

  // New session connects — ensureMount cancels the timer
  await mgr.ensureMount("h1", "/home/user");
  assertEquals(timers.size, 0); // Timer was cleared
});

Deno.test("forceUnmount: falls back to diskutil when umount fails", async () => {
  const { deps, calls } = createFakeDeps({
    sshfsSuccess: true,
    umountSuccess: false,
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.ensureMount("h1", "/home/user");
  await mgr.unmountHost("h1");

  const umountCalls = calls.filter((c) => c.cmd === "umount");
  const diskutilCalls = calls.filter((c) => c.cmd === "diskutil");
  assertEquals(umountCalls.length, 1);
  assertEquals(diskutilCalls.length, 1);
  assertEquals(diskutilCalls[0].args, ["unmount", "force", "/mnt/h1"]);
});

Deno.test("unmountAll: unmounts all hosts", async () => {
  const { deps, calls } = createFakeDeps({
    sshfsSuccess: true,
    umountSuccess: true,
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.ensureMount("h1", "/home/user1");
  await mgr.ensureMount("h2", "/home/user2");
  assertEquals(mgr.getAllMounts().size, 2);

  await mgr.unmountAll();
  assertEquals(mgr.getAllMounts().size, 0);
  const umountCalls = calls.filter((c) => c.cmd === "umount");
  assertEquals(umountCalls.length, 2);
});

Deno.test("isMounted: checks mount output", async () => {
  const { deps } = createFakeDeps({ mountOutput: MOUNT_H1 });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  assertEquals(await mgr.isMounted("/mnt/h1"), true);
  assertEquals(await mgr.isMounted("/mnt/h2"), false);
});

Deno.test("isMountResponsive: false when not mounted", async () => {
  const { deps } = createFakeDeps({ mountOutput: "" });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  assertEquals(await mgr.isMountResponsive("/mnt/h1"), false);
});

Deno.test("isMountResponsive: false when stat fails", async () => {
  const { deps } = createFakeDeps({
    mountOutput: MOUNT_H1,
    statSuccess: false,
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  assertEquals(await mgr.isMountResponsive("/mnt/h1"), false);
});

Deno.test("isMountResponsive: true when mounted and stat succeeds", async () => {
  const { deps } = createFakeDeps({
    mountOutput: MOUNT_H1,
    statSuccess: true,
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  assertEquals(await mgr.isMountResponsive("/mnt/h1"), true);
});

Deno.test("session tracking via mount state", async () => {
  const { deps } = createFakeDeps({ sshfsSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  const state = await mgr.ensureMount("h1", "/home/user");
  state.sessions.add("s1");
  state.sessions.add("s2");
  assertEquals(state.sessions.size, 2);

  state.sessions.delete("s1");
  assertEquals(state.sessions.size, 1);
  assertEquals(state.sessions.has("s2"), true);
});

// --- parseMountPoints ---

Deno.test("parseMountPoints: extracts paths from real mount(8) output", () => {
  const output = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "devfs on /dev (devfs, local, nobrowse)",
    "work@macfuse0 on /Users/me/.remote-mounts/work (macfuse, nodev, nosuid)",
  ].join("\n");

  assertEquals(parseMountPoints(output), [
    "/",
    "/dev",
    "/Users/me/.remote-mounts/work",
  ]);
});

Deno.test("parseMountPoints: ignores blank and malformed lines", () => {
  assertEquals(parseMountPoints(""), []);
  assertEquals(parseMountPoints("\n\n"), []);
  assertEquals(parseMountPoints("not a mount line"), []);
});

Deno.test("parseMountPoints: handles a mount point containing spaces", () => {
  const output = "/dev/disk4 on /Volumes/My Disk (hfs, local, nodev)";
  assertEquals(parseMountPoints(output), ["/Volumes/My Disk"]);
});

Deno.test("isMounted: a prefix of another mount point is not a match", async () => {
  // The regression: a substring search over `mount` output meant host `work`
  // matched the line belonging to `work2`, so the daemon believed a mount was
  // live when it was not.
  const { deps } = createFakeDeps({ mountOutput: mountLine("/mnt/work2") });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  assertEquals(await mgr.isMounted("/mnt/work2"), true);
  assertEquals(await mgr.isMounted("/mnt/work"), false);
});

Deno.test("isMounted: a longer name is not matched by a shorter mount", async () => {
  const { deps } = createFakeDeps({ mountOutput: mountLine("/mnt/work") });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  assertEquals(await mgr.isMounted("/mnt/work"), true);
  assertEquals(await mgr.isMounted("/mnt/work2"), false);
});

// --- persistence ---

Deno.test("persist: a successful mount is written to the state file", async () => {
  const { deps, files } = createFakeDeps({ sshfsSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.ensureMount("h1", "/home/user");

  const written = JSON.parse(files.get(STATE_PATH)!);
  assertEquals(written.version, 1);
  assertEquals(written.mounts, [
    { host: "h1", remoteHome: "/home/user", mountPoint: "/mnt/h1" },
  ]);
});

Deno.test("persist: unmounting removes the host from the state file", async () => {
  const { deps, files } = createFakeDeps({ sshfsSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.ensureMount("h1", "/home/user");
  await mgr.ensureMount("h2", "/home/user");
  await mgr.unmountHost("h1");

  const written = JSON.parse(files.get(STATE_PATH)!);
  assertEquals(written.mounts.map((m: { host: string }) => m.host), ["h2"]);
});

Deno.test("persist: sessions are never written to disk", async () => {
  // Session ids belong to shells that will not survive a restart.
  const { deps, files } = createFakeDeps({ sshfsSuccess: true });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  const state = await mgr.ensureMount("h1", "/home/user");
  state.sessions.add("shell-1");
  await mgr.unmountHost("h1");
  await mgr.ensureMount("h1", "/home/user");

  assertEquals(files.get(STATE_PATH)!.includes("shell-1"), false);
});

Deno.test("persist: a write failure does not fail the mount", async () => {
  const { deps, logs } = createFakeDeps({ sshfsSuccess: true });
  deps.writeTextFile = () => Promise.reject(new Error("disk full"));
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  const state = await mgr.ensureMount("h1", "/home/user");

  assertEquals(state.mountPoint, "/mnt/h1");
  assertEquals(logs.some((l) => l.includes("Could not persist")), true);
});

// --- restore ---

const persisted = (
  mounts: Array<{ host: string; remoteHome: string; mountPoint: string }>,
) => JSON.stringify({ version: 1, mounts });

Deno.test("restore: recovers entries whose mount is still live", async () => {
  // The bug this fixes: a restart lost the table while the sshfs mounts
  // survived, so the next request mounted a second time on the same point.
  const { deps, calls } = createFakeDeps({
    mountOutput: mountLine("/mnt/h1"),
    files: [[
      STATE_PATH,
      persisted([{
        host: "h1",
        remoteHome: "/home/user",
        mountPoint: "/mnt/h1",
      }]),
    ]],
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  assertEquals(mgr.getAllMounts().size, 1);
  assertEquals(mgr.getMount("h1")?.remoteHome, "/home/user");
  // and a later request reuses it rather than mounting again
  await mgr.ensureMount("h1", "/home/user");
  assertEquals(calls.filter((c) => c.cmd === "sshfs").length, 0);
});

Deno.test("restore: drops entries whose mount point is gone", async () => {
  const { deps, logs } = createFakeDeps({
    mountOutput: "",
    files: [[
      STATE_PATH,
      persisted([{
        host: "h1",
        remoteHome: "/home/user",
        mountPoint: "/mnt/h1",
      }]),
    ]],
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  assertEquals(mgr.getAllMounts().size, 0);
  assertEquals(logs.some((l) => l.includes("Dropped 1 stale")), true);
});

Deno.test("restore: recovered mounts carry no sessions", async () => {
  const { deps } = createFakeDeps({
    mountOutput: mountLine("/mnt/h1"),
    files: [[
      STATE_PATH,
      persisted([{
        host: "h1",
        remoteHome: "/home/user",
        mountPoint: "/mnt/h1",
      }]),
    ]],
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  assertEquals(mgr.getMount("h1")?.sessions.size, 0);
});

Deno.test("restore: rewrites the file so stale entries do not linger", async () => {
  const { deps, files } = createFakeDeps({
    mountOutput: mountLine("/mnt/live"),
    files: [[
      STATE_PATH,
      persisted([
        { host: "live", remoteHome: "/home/u", mountPoint: "/mnt/live" },
        { host: "gone", remoteHome: "/home/u", mountPoint: "/mnt/gone" },
      ]),
    ]],
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  const written = JSON.parse(files.get(STATE_PATH)!);
  assertEquals(written.mounts.map((m: { host: string }) => m.host), ["live"]);
});

Deno.test("restore: a missing state file is not an error", async () => {
  const { deps, logs } = createFakeDeps({});
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  assertEquals(mgr.getAllMounts().size, 0);
  assertEquals(logs.length, 0);
});

Deno.test("restore: malformed JSON is ignored, not fatal", async () => {
  const { deps, logs } = createFakeDeps({
    files: [[STATE_PATH, "{ not json"]],
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  assertEquals(mgr.getAllMounts().size, 0);
  assertEquals(logs.some((l) => l.includes("unreadable mount state")), true);
});

Deno.test("restore: an unrecognised schema version is ignored", async () => {
  const { deps, logs } = createFakeDeps({
    files: [[STATE_PATH, JSON.stringify({ version: 99, mounts: [] })]],
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  assertEquals(mgr.getAllMounts().size, 0);
  assertEquals(logs.some((l) => l.includes("unrecognised format")), true);
});

Deno.test("restore: entries with the wrong field types are rejected", async () => {
  const { deps } = createFakeDeps({
    files: [[
      STATE_PATH,
      JSON.stringify({ version: 1, mounts: [{ host: 42, remoteHome: null }] }),
    ]],
  });
  const mgr = new MountManager(deps, "/mnt", 30000, STATE_PATH);

  await mgr.restore();

  assertEquals(mgr.getAllMounts().size, 0);
});
