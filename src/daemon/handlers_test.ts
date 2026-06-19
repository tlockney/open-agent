import { assertEquals } from "jsr:@std/assert@1";
import {
  type CommandResult,
  handleConnect,
  handleCopy,
  handleDisconnect,
  handleDoctor,
  handleNotify,
  handleOpen,
  handleOpenUrl,
  handleOpenVscode,
  handleOpRead,
  handleOpResolve,
  handlePaste,
  handlePing,
  handlePull,
  handlePush,
  type HandlerDeps,
  handleReset,
  handleStatus,
  type SpawnedProcess,
} from "./handlers.ts";
import { type MountDeps, MountManager } from "./mount_manager.ts";

const encoder = new TextEncoder();

interface Call {
  cmd: string;
  args: string[];
}

/** Create a minimal MountManager with a fake mount already in place. */
function createFakeMountManager(opts?: {
  /** Make sshfs return failure on the Nth+1 invocation onward (1-indexed). */
  failSshfsAfterCall?: number;
  /** Make `stat <mountpoint>` (used by isMountResponsive) return failure. */
  failStat?: boolean;
}): MountManager {
  // Track which mount points the fake considers "mounted" so isMountResponsive
  // can correctly distinguish present vs. missing mounts across remount cycles.
  const mounted = new Set<string>();
  let sshfsCalls = 0;

  const encoder = new TextEncoder();
  const deps: MountDeps = {
    async runCommand(cmd, args) {
      if (cmd === "sshfs") {
        sshfsCalls++;
        if (
          opts?.failSshfsAfterCall !== undefined &&
          sshfsCalls > opts.failSshfsAfterCall
        ) {
          return {
            success: false,
            stdout: new Uint8Array(),
            stderr: encoder.encode("auth denied"),
          };
        }
        const mp = args?.[1];
        if (typeof mp === "string") mounted.add(mp);
        return {
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "mount") {
        const list = [...mounted].map((mp) => `fakefs on ${mp}`).join("\n");
        return {
          success: true,
          stdout: encoder.encode(list),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "umount" || cmd === "diskutil") {
        // Last arg is the mount point for both umount and diskutil unmount force.
        const mp = args?.[args.length - 1];
        if (typeof mp === "string") mounted.delete(mp);
        return {
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      if (cmd === "stat" && opts?.failStat) {
        return {
          success: false,
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
    log() {},
    setTimeout(_fn, _ms) {
      return 0;
    },
    clearTimeout() {},
  };
  return new MountManager(deps, "/mnt", 30000);
}

/** Create fake handler deps with configurable command responses. */
function createFakeDeps(opts?: {
  commandResults?: Map<string, CommandResult>;
  statResult?: { isDirectory: boolean };
  statThrows?: boolean;
  /** Throw on stat for any path matching one of these substrings. */
  statThrowsFor?: string[];
  /** Custom stat function — overrides the other stat options entirely. */
  stat?: (path: string) => Promise<{ isDirectory: boolean }>;
  /** Custom mount manager — overrides the default fake. */
  mountManager?: MountManager;
}): {
  deps: HandlerDeps;
  calls: Call[];
  logs: string[];
  copies: Array<{ src: string; dest: string }>;
} {
  const calls: Call[] = [];
  const logs: string[] = [];
  const copies: Array<{ src: string; dest: string }> = [];

  const defaultStat = async (path: string) => {
    if (opts?.statThrowsFor?.some((s) => path.includes(s))) {
      throw new Error("not found");
    }
    if (opts?.statThrows) throw new Error("not found");
    return opts?.statResult ?? { isDirectory: false };
  };

  const deps: HandlerDeps = {
    mountManager: opts?.mountManager ?? createFakeMountManager(),
    async runCommand(cmd, args) {
      calls.push({ cmd, args });
      const result = opts?.commandResults?.get(cmd);
      if (result) return result;
      return {
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
    spawnCommand(cmd, _opts) {
      calls.push({ cmd, args: [] });
      return {
        stdin: new WritableStream<Uint8Array>({
          write(_chunk) {/* captured for testing if needed */},
        }),
        async output() {
          return { success: true };
        },
      } satisfies SpawnedProcess;
    },
    async copyFile(src, dest) {
      copies.push({ src, dest });
    },
    stat: opts?.stat ?? defaultStat,
    log(msg) {
      logs.push(msg);
    },
    home: "/Users/test",
    version: "0.3.0",
  };

  return { deps, calls, logs, copies };
}

// --- connect / disconnect ---

Deno.test("handleConnect: mounts and tracks session", async () => {
  const { deps } = createFakeDeps();
  const result = JSON.parse(
    await handleConnect({
      action: "connect",
      host: "h1",
      remoteHome: "/home/u",
      sessionId: "s1",
    }, deps),
  );
  assertEquals(result.ok, true);
  assertEquals(result.mountPoint, "/mnt/h1");
});

Deno.test("handleDisconnect: removes session and schedules unmount", () => {
  const { deps } = createFakeDeps();
  // First ensure a mount exists with a session
  deps.mountManager.ensureMount("h1", "/home/u").then((state) => {
    state.sessions.add("s1");
  });
  // Disconnect won't error even if mount doesn't exist yet in sync context
  const result = JSON.parse(
    handleDisconnect(
      { action: "disconnect", host: "h1", sessionId: "s1" },
      deps,
    ),
  );
  assertEquals(result.ok, true);
});

// --- open ---

Deno.test("handleOpen: invokes open with translated path", async () => {
  const { deps, calls } = createFakeDeps();
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handleOpen({
      action: "open",
      host: "h1",
      remoteHome: "/home/u",
      path: "/home/u/file.md",
    }, deps),
  );
  assertEquals(result.ok, true);
  assertEquals(result.localPath, "/mnt/h1/file.md");

  const openCalls = calls.filter((c) => c.cmd === "open");
  assertEquals(openCalls.length, 1);
  assertEquals(openCalls[0].args, ["/mnt/h1/file.md"]);
});

Deno.test("handleOpen: passes -a flag for app", async () => {
  const { deps, calls } = createFakeDeps();
  await deps.mountManager.ensureMount("h1", "/home/u");

  await handleOpen(
    {
      action: "open",
      host: "h1",
      remoteHome: "/home/u",
      path: "/home/u/doc.md",
      app: "Marked 2",
    },
    deps,
  );

  const openCalls = calls.filter((c) => c.cmd === "open");
  assertEquals(openCalls[0].args, ["-a", "Marked 2", "/mnt/h1/doc.md"]);
});

Deno.test("handleOpen: returns path_not_found when target is missing but mount is alive", async () => {
  // statThrowsFor: only the missing file path throws; mount root stat succeeds
  const { deps, calls } = createFakeDeps({ statThrowsFor: ["missing.md"] });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handleOpen(
      {
        action: "open",
        host: "h1",
        remoteHome: "/home/u",
        path: "/home/u/missing.md",
      },
      deps,
    ),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "path_not_found");
  assertEquals(result.error.host, "h1");
  // Should not have attempted to invoke `open`.
  assertEquals(calls.filter((c) => c.cmd === "open").length, 0);
});

Deno.test("handleOpen: returns mount_stale when remount itself fails", async () => {
  // First sshfs call (initial mount) succeeds; the remount call after
  // detecting a dead mount fails — recovery exhausted.
  const mountManager = createFakeMountManager({ failSshfsAfterCall: 1 });
  const { deps, calls } = createFakeDeps({ statThrows: true, mountManager });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handleOpen(
      {
        action: "open",
        host: "h1",
        remoteHome: "/home/u",
        path: "/home/u/f.md",
      },
      deps,
    ),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "mount_stale");
  assertEquals(result.error.host, "h1");
  assertEquals(result.error.recovery, "ra reset h1");
  assertEquals(calls.filter((c) => c.cmd === "open").length, 0);
});

Deno.test("handleOpen: silently recovers when remount restores the path", async () => {
  // First stat (path) throws, second stat (mount root) throws, after
  // remount the third stat (path) succeeds — silent recovery.
  let statCount = 0;
  const stat = async (_path: string) => {
    statCount++;
    if (statCount <= 2) throw new Error("dead mount");
    return { isDirectory: false };
  };
  const { deps, calls, logs } = createFakeDeps({ stat });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handleOpen(
      {
        action: "open",
        host: "h1",
        remoteHome: "/home/u",
        path: "/home/u/f.md",
      },
      deps,
    ),
  );
  assertEquals(result.ok, true);
  assertEquals(result.localPath, "/mnt/h1/f.md");
  // open was invoked exactly once after the recovery.
  assertEquals(calls.filter((c) => c.cmd === "open").length, 1);
  // Recovery log line was emitted.
  assertEquals(logs.some((l) => l.includes("died silently")), true);
});

Deno.test("handleOpen: returns error on command failure", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("open", {
    success: false,
    stdout: new Uint8Array(),
    stderr: encoder.encode("file not found"),
  });
  const { deps } = createFakeDeps({ commandResults });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handleOpen({
      action: "open",
      host: "h1",
      remoteHome: "/home/u",
      path: "/home/u/f",
    }, deps),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "internal");
  assertEquals(result.error.message, "open failed: file not found");
});

// --- open-vscode ---

Deno.test("handleOpenVscode: invokes code with remote args", async () => {
  const { deps, calls } = createFakeDeps();
  const result = JSON.parse(
    await handleOpenVscode({
      action: "open-vscode",
      host: "h1",
      path: "/home/u/project",
    }, deps),
  );
  assertEquals(result.ok, true);

  const codeCalls = calls.filter((c) => c.cmd === "code");
  assertEquals(codeCalls[0].args, [
    "--remote",
    "ssh-remote+h1",
    "/home/u/project",
  ]);
});

// --- copy ---

Deno.test("handleCopy: spawns pbcopy and reports bytes", async () => {
  const { deps, calls } = createFakeDeps();
  const result = JSON.parse(
    await handleCopy({ action: "copy", content: "hello world" }, deps),
  );
  assertEquals(result.ok, true);
  assertEquals(result.bytes, 11);

  const pbcopyCalls = calls.filter((c) => c.cmd === "pbcopy");
  assertEquals(pbcopyCalls.length, 1);
});

// --- paste ---

Deno.test("handlePaste: returns clipboard content", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("pbpaste", {
    success: true,
    stdout: encoder.encode("clipboard text"),
    stderr: new Uint8Array(),
  });
  const { deps } = createFakeDeps({ commandResults });
  const result = JSON.parse(await handlePaste(deps));
  assertEquals(result.ok, true);
  assertEquals(result.content, "clipboard text");
});

Deno.test("handlePaste: returns error on failure", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("pbpaste", {
    success: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  });
  const { deps } = createFakeDeps({ commandResults });
  const result = JSON.parse(await handlePaste(deps));
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "internal");
  assertEquals(result.error.message, "pbpaste failed");
});

// --- notify ---

Deno.test("handleNotify: builds terminal-notifier args", async () => {
  const { deps, calls } = createFakeDeps();
  const result = JSON.parse(
    await handleNotify(
      {
        action: "notify",
        title: "Build",
        message: "Done",
        subtitle: "proj",
        sound: "Ping",
      },
      deps,
    ),
  );
  assertEquals(result.ok, true);

  const notifyCalls = calls.filter((c) => c.cmd === "terminal-notifier");
  assertEquals(notifyCalls[0].args, [
    "-title",
    "Build",
    "-message",
    "Done",
    "-subtitle",
    "proj",
    "-sound",
    "Ping",
  ]);
});

Deno.test("handleNotify: title only", async () => {
  const { deps, calls } = createFakeDeps();
  await handleNotify({ action: "notify", title: "Done" }, deps);
  const notifyCalls = calls.filter((c) => c.cmd === "terminal-notifier");
  assertEquals(notifyCalls[0].args, ["-title", "Done"]);
});

// --- open-url ---

Deno.test("handleOpenUrl: opens valid http URL", async () => {
  const { deps, calls } = createFakeDeps();
  const result = JSON.parse(
    await handleOpenUrl(
      { action: "open-url", url: "https://example.com" },
      deps,
    ),
  );
  assertEquals(result.ok, true);
  const openCalls = calls.filter((c) => c.cmd === "open");
  assertEquals(openCalls[0].args, ["https://example.com"]);
});

Deno.test("handleOpenUrl: rejects non-http URL", async () => {
  const { deps } = createFakeDeps();
  const result = JSON.parse(
    await handleOpenUrl({ action: "open-url", url: "ftp://evil.com" }, deps),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "internal");
  assertEquals(result.error.message, "Only http/https URLs are supported");
});

// --- push ---

Deno.test("handlePush: copies file to Downloads", async () => {
  const { deps, copies } = createFakeDeps();
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handlePush(
      {
        action: "push",
        host: "h1",
        remoteHome: "/home/u",
        path: "/home/u/build.tar.gz",
      },
      deps,
    ),
  );
  assertEquals(result.ok, true);
  assertEquals(result.localPath, "/Users/test/Downloads/build.tar.gz");
  assertEquals(copies[0], {
    src: "/mnt/h1/build.tar.gz",
    dest: "/Users/test/Downloads/build.tar.gz",
  });
});

Deno.test("handlePush: returns path_not_found when source is missing but mount is alive", async () => {
  const { deps, copies } = createFakeDeps({
    statThrowsFor: ["missing.tar.gz"],
  });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handlePush(
      {
        action: "push",
        host: "h1",
        remoteHome: "/home/u",
        path: "/home/u/missing.tar.gz",
      },
      deps,
    ),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "path_not_found");
  assertEquals(result.error.host, "h1");
  assertEquals(copies.length, 0);
});

Deno.test("handlePush: returns mount_stale when remount itself fails", async () => {
  const mountManager = createFakeMountManager({ failSshfsAfterCall: 1 });
  const { deps, copies } = createFakeDeps({ statThrows: true, mountManager });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handlePush(
      {
        action: "push",
        host: "h1",
        remoteHome: "/home/u",
        path: "/home/u/build.tar.gz",
      },
      deps,
    ),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "mount_stale");
  assertEquals(result.error.recovery, "ra reset h1");
  assertEquals(copies.length, 0);
});

Deno.test("handlePush: uses custom dest", async () => {
  const { deps, copies } = createFakeDeps();
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handlePush(
      {
        action: "push",
        host: "h1",
        remoteHome: "/home/u",
        path: "/home/u/f.txt",
        dest: "/tmp",
      },
      deps,
    ),
  );
  assertEquals(result.localPath, "/tmp/f.txt");
  assertEquals(copies[0].dest, "/tmp/f.txt");
});

// --- pull ---

Deno.test("handlePull: copies file to mount path", async () => {
  const { deps, copies } = createFakeDeps({ statThrows: true });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handlePull(
      {
        action: "pull",
        host: "h1",
        remoteHome: "/home/u",
        localPath: "/local/img.png",
        remoteDest: "/home/u/dest",
      },
      deps,
    ),
  );
  assertEquals(result.ok, true);
  assertEquals(copies[0], { src: "/local/img.png", dest: "/mnt/h1/dest" });
});

Deno.test("handlePull: appends filename when dest is directory", async () => {
  const { deps, copies } = createFakeDeps({
    statResult: { isDirectory: true },
  });
  await deps.mountManager.ensureMount("h1", "/home/u");

  await handlePull(
    {
      action: "pull",
      host: "h1",
      remoteHome: "/home/u",
      localPath: "/local/img.png",
      remoteDest: "/home/u/dir",
    },
    deps,
  );
  assertEquals(copies[0].dest, "/mnt/h1/dir/img.png");
});

// --- op-read ---

Deno.test("handleOpRead: resolves op reference", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("op", {
    success: true,
    stdout: encoder.encode("secret-value\n"),
    stderr: new Uint8Array(),
  });
  const { deps, calls } = createFakeDeps({ commandResults });

  const result = JSON.parse(
    await handleOpRead(
      { action: "op-read", ref: "op://vault/item/field" },
      deps,
    ),
  );
  assertEquals(result.ok, true);
  assertEquals(result.value, "secret-value");

  const opCalls = calls.filter((c) => c.cmd === "op");
  assertEquals(opCalls[0].args, ["read", "op://vault/item/field"]);
});

Deno.test("handleOpRead: passes account flag", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("op", {
    success: true,
    stdout: encoder.encode("val"),
    stderr: new Uint8Array(),
  });
  const { deps, calls } = createFakeDeps({ commandResults });

  await handleOpRead(
    { action: "op-read", ref: "op://v/i/f", account: "work" },
    deps,
  );
  const opCalls = calls.filter((c) => c.cmd === "op");
  assertEquals(opCalls[0].args, ["--account", "work", "read", "op://v/i/f"]);
});

Deno.test("handleOpRead: returns error on failure", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("op", {
    success: false,
    stdout: new Uint8Array(),
    stderr: encoder.encode("not found"),
  });
  const { deps } = createFakeDeps({ commandResults });

  const result = JSON.parse(
    await handleOpRead({ action: "op-read", ref: "op://v/i/f" }, deps),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "internal");
  assertEquals(result.error.message, "op read failed: not found");
});

// --- op-resolve ---

Deno.test("handleOpResolve: resolves multiple refs", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("op", {
    success: true,
    stdout: encoder.encode("resolved-val"),
    stderr: new Uint8Array(),
  });
  const { deps } = createFakeDeps({ commandResults });

  const result = JSON.parse(
    await handleOpResolve(
      {
        action: "op-resolve",
        refs: { DB: "op://v/db/url", KEY: "op://v/api/key" },
      },
      deps,
    ),
  );
  assertEquals(result.ok, true);
  assertEquals(result.resolved.DB, "resolved-val");
  assertEquals(result.resolved.KEY, "resolved-val");
});

Deno.test("handleOpResolve: aggregates errors", async () => {
  const commandResults = new Map<string, CommandResult>();
  commandResults.set("op", {
    success: false,
    stdout: new Uint8Array(),
    stderr: encoder.encode("denied"),
  });
  const { deps } = createFakeDeps({ commandResults });

  const result = JSON.parse(
    await handleOpResolve(
      { action: "op-resolve", refs: { A: "op://v/a/f", B: "op://v/b/f" } },
      deps,
    ),
  );
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "internal");
  assertEquals(result.error.message.includes("A: denied"), true);
  assertEquals(result.error.message.includes("B: denied"), true);
});

// --- status ---

Deno.test("handleStatus: returns version and empty mounts", () => {
  const { deps } = createFakeDeps();
  const result = JSON.parse(handleStatus(deps));
  assertEquals(result.ok, true);
  assertEquals(result.version, "0.3.0");
  assertEquals(result.mounts, {});
});

Deno.test("handleStatus: includes mount info", async () => {
  const { deps } = createFakeDeps();
  const state = await deps.mountManager.ensureMount("h1", "/home/u");
  state.sessions.add("s1");

  const result = JSON.parse(handleStatus(deps));
  assertEquals(result.mounts.h1.mountPoint, "/mnt/h1");
  assertEquals(result.mounts.h1.activeSessions, 1);
  assertEquals(result.mounts.h1.sessions, ["s1"]);
});

// --- reset ---

Deno.test("handleReset: with no host tears down all mounts", async () => {
  const { deps } = createFakeDeps();
  await deps.mountManager.ensureMount("h1", "/home/u");
  await deps.mountManager.ensureMount("h2", "/home/u");

  const result = JSON.parse(
    await handleReset({ action: "reset" }, deps),
  );
  assertEquals(result.ok, true);
  assertEquals((result.reset as string[]).sort(), ["h1", "h2"]);
  assertEquals([...deps.mountManager.getAllMounts().keys()], []);
});

Deno.test("handleReset: with host scopes to that host only", async () => {
  const { deps } = createFakeDeps();
  await deps.mountManager.ensureMount("h1", "/home/u");
  await deps.mountManager.ensureMount("h2", "/home/u");

  const result = JSON.parse(
    await handleReset({ action: "reset", host: "h1" }, deps),
  );
  assertEquals(result.ok, true);
  assertEquals(result.reset, ["h1"]);
  assertEquals([...deps.mountManager.getAllMounts().keys()], ["h2"]);
});

Deno.test("handleReset: returns empty list when nothing to reset", async () => {
  const { deps } = createFakeDeps();
  const result = JSON.parse(await handleReset({ action: "reset" }, deps));
  assertEquals(result.ok, true);
  assertEquals(result.reset, []);
});

Deno.test("handleReset: unknown host is a no-op (not an error)", async () => {
  const { deps } = createFakeDeps();
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(
    await handleReset({ action: "reset", host: "ghost" }, deps),
  );
  assertEquals(result.ok, true);
  assertEquals(result.reset, []);
  // Unrelated mount untouched.
  assertEquals(deps.mountManager.getMount("h1") !== undefined, true);
});

// --- doctor ---

Deno.test("handleDoctor: empty when no mounts exist", async () => {
  const { deps } = createFakeDeps();
  const result = JSON.parse(await handleDoctor(deps));
  assertEquals(result.ok, true);
  assertEquals(result.version, "0.3.0");
  assertEquals(result.mounts, {});
});

Deno.test("handleDoctor: marks responsive mounts and includes session info", async () => {
  const { deps } = createFakeDeps();
  const state = await deps.mountManager.ensureMount("h1", "/home/u");
  state.sessions.add("s1");
  state.sessions.add("s2");

  const result = JSON.parse(await handleDoctor(deps));
  assertEquals(result.ok, true);
  assertEquals(result.mounts.h1.responsive, true);
  assertEquals(result.mounts.h1.activeSessions, 2);
  assertEquals(result.mounts.h1.mountPoint, "/mnt/h1");
  assertEquals(result.mounts.h1.pendingUnmount, false);
});

Deno.test("handleDoctor: marks unresponsive mounts when stat probe fails", async () => {
  // Mount manager that creates the mount but stat probes will fail.
  const mountManager = createFakeMountManager({ failStat: true });
  const { deps } = createFakeDeps({ mountManager });
  await deps.mountManager.ensureMount("h1", "/home/u");

  const result = JSON.parse(await handleDoctor(deps));
  assertEquals(result.ok, true);
  assertEquals(result.mounts.h1.responsive, false);
});

// --- ping ---

Deno.test("handlePing: returns pong and version without touching deps", () => {
  const { deps, calls } = createFakeDeps();
  const result = JSON.parse(handlePing(deps));
  assertEquals(result.ok, true);
  assertEquals(result.pong, true);
  assertEquals(result.version, "0.3.0");
  // ping must NOT shell out to anything — that would defeat its purpose
  // as a "is the daemon hung?" probe.
  assertEquals(calls.length, 0);
});
