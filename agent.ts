#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=unix

// open-agent: local daemon that receives open requests from remote machines
// via a forwarded Unix socket, manages SSHFS mounts, and opens files locally.

const HOME = Deno.env.get("HOME")!;
const AGENT_DIR = `${HOME}/.local/share/open-agent`;
const SOCKET_PATH = `${AGENT_DIR}/open-agent.sock`;
const MOUNT_BASE = `${HOME}/.remote-mounts`;
const LOG_PATH = `${AGENT_DIR}/agent.log`;
const UNMOUNT_GRACE_MS = 30_000; // 30s after last session disconnects

// --- Logging ---

let logFile: Deno.FsFile | null = null;

async function initLog(): Promise<void> {
  await Deno.mkdir(AGENT_DIR, { recursive: true });
  logFile = await Deno.open(LOG_PATH, {
    write: true,
    create: true,
    append: true,
  });
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(msg);
  logFile?.write(new TextEncoder().encode(line));
}

// --- Types ---

type Message =
  | { action: "open"; host: string; remoteHome: string; path: string; app?: string }
  | { action: "open-vscode"; host: string; path: string }
  | { action: "connect"; host: string; remoteHome: string; sessionId: string }
  | { action: "disconnect"; host: string; sessionId: string }
  | { action: "status" };

interface MountState {
  host: string;
  remoteHome: string;
  mountPoint: string;
  sessions: Set<string>;
  unmountTimer?: number;
}

const mounts = new Map<string, MountState>();

// --- Mount management ---

async function isMounted(mountPoint: string): Promise<boolean> {
  try {
    const cmd = new Deno.Command("mount");
    const { stdout } = await cmd.output();
    const output = new TextDecoder().decode(stdout);
    return output.includes(mountPoint);
  } catch {
    return false;
  }
}

async function isMountResponsive(mountPoint: string): Promise<boolean> {
  if (!await isMounted(mountPoint)) return false;
  try {
    // Quick stat with a timeout — hung FUSE mounts block indefinitely
    const cmd = new Deno.Command("stat", {
      args: [mountPoint],
      signal: AbortSignal.timeout(3000),
    });
    const result = await cmd.output();
    return result.success;
  } catch {
    return false;
  }
}

async function ensureMount(host: string, remoteHome: string): Promise<MountState> {
  let state = mounts.get(host);

  if (state) {
    // Cancel any pending unmount
    if (state.unmountTimer !== undefined) {
      clearTimeout(state.unmountTimer);
      state.unmountTimer = undefined;
    }

    // Update remoteHome if it changed (shouldn't, but defensive)
    state.remoteHome = remoteHome;

    // Verify mount is alive
    if (await isMountResponsive(state.mountPoint)) {
      return state;
    }

    // Mount died — clean up and remount
    log(`Mount for ${host} is stale, remounting...`);
    await forceUnmount(state.mountPoint);
  }

  const mountPoint = `${MOUNT_BASE}/${host}`;
  await Deno.mkdir(mountPoint, { recursive: true });

  log(`Mounting ${host}:${remoteHome} at ${mountPoint}`);
  const cmd = new Deno.Command("sshfs", {
    args: [
      `${host}:${remoteHome}`,
      mountPoint,
      "-o", "reconnect",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "follow_symlinks",
      "-o", `volname=remote-${host}`,
      // Caching for performance — slightly stale metadata is fine for opens
      "-o", "cache=yes",
      "-o", "cache_timeout=120",
      "-o", "attr_timeout=120",
    ],
  });

  const result = await cmd.output();
  if (!result.success) {
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(`sshfs mount failed: ${err}`);
  }

  state = {
    host,
    remoteHome,
    mountPoint,
    sessions: state?.sessions ?? new Set(),
  };
  mounts.set(host, state);
  log(`Mounted ${host} successfully`);
  return state;
}

async function forceUnmount(mountPoint: string): Promise<void> {
  try {
    // Try normal unmount first
    const cmd = new Deno.Command("umount", { args: [mountPoint] });
    const result = await cmd.output();
    if (result.success) return;
  } catch { /* fall through */ }

  try {
    // macOS: diskutil force unmount
    const cmd = new Deno.Command("diskutil", {
      args: ["unmount", "force", mountPoint],
    });
    await cmd.output();
  } catch (e) {
    log(`Force unmount failed for ${mountPoint}: ${e}`);
  }
}

async function unmountHost(host: string): Promise<void> {
  const state = mounts.get(host);
  if (!state) return;

  log(`Unmounting ${host} (${state.mountPoint})`);
  await forceUnmount(state.mountPoint);
  mounts.delete(host);
}

function scheduleUnmount(host: string): void {
  const state = mounts.get(host);
  if (!state) return;

  if (state.unmountTimer !== undefined) {
    clearTimeout(state.unmountTimer);
  }

  log(`Scheduling unmount for ${host} in ${UNMOUNT_GRACE_MS / 1000}s`);
  state.unmountTimer = setTimeout(() => {
    if (state.sessions.size === 0) {
      unmountHost(host);
    }
  }, UNMOUNT_GRACE_MS);
}

// --- Path translation ---

function translatePath(remotePath: string, state: MountState): string {
  if (remotePath.startsWith(state.remoteHome)) {
    const relative = remotePath.slice(state.remoteHome.length);
    return state.mountPoint + relative;
  }
  throw new Error(
    `Path outside remote home: ${remotePath} (home: ${state.remoteHome}). ` +
    `Only paths under the remote home directory are accessible via SSHFS.`
  );
}

// --- Command handlers ---

async function handleMessage(msg: Message): Promise<string> {
  switch (msg.action) {
    case "connect": {
      const state = await ensureMount(msg.host, msg.remoteHome);
      state.sessions.add(msg.sessionId);
      log(`Session ${msg.sessionId}@${msg.host} connected (${state.sessions.size} active)`);
      return JSON.stringify({ ok: true, mountPoint: state.mountPoint });
    }

    case "disconnect": {
      const state = mounts.get(msg.host);
      if (state) {
        state.sessions.delete(msg.sessionId);
        log(`Session ${msg.sessionId}@${msg.host} disconnected (${state.sessions.size} remaining)`);
        if (state.sessions.size === 0) {
          scheduleUnmount(msg.host);
        }
      }
      return JSON.stringify({ ok: true });
    }

    case "open": {
      const state = await ensureMount(msg.host, msg.remoteHome);
      const localPath = translatePath(msg.path, state);

      const args: string[] = [];
      if (msg.app) args.push("-a", msg.app);
      args.push(localPath);

      log(`open ${args.join(" ")}`);
      const cmd = new Deno.Command("open", { args });
      const result = await cmd.output();

      if (!result.success) {
        const err = new TextDecoder().decode(result.stderr);
        return JSON.stringify({ ok: false, error: `open failed: ${err}` });
      }
      return JSON.stringify({ ok: true, localPath });
    }

    case "open-vscode": {
      // VS Code remote-ssh handles its own connection — no SSHFS needed
      const args = ["--remote", `ssh-remote+${msg.host}`, msg.path];
      log(`code ${args.join(" ")}`);
      const cmd = new Deno.Command("code", { args });
      const result = await cmd.output();

      if (!result.success) {
        const err = new TextDecoder().decode(result.stderr);
        return JSON.stringify({ ok: false, error: `code failed: ${err}` });
      }
      return JSON.stringify({ ok: true });
    }

    case "status": {
      const status = Object.fromEntries(
        [...mounts.entries()].map(([host, state]) => [
          host,
          {
            mountPoint: state.mountPoint,
            remoteHome: state.remoteHome,
            activeSessions: state.sessions.size,
            sessions: [...state.sessions],
            pendingUnmount: state.unmountTimer !== undefined,
          },
        ])
      );
      return JSON.stringify({ ok: true, mounts: status });
    }
  }
}

// --- Socket server ---

async function handleConnection(conn: Deno.Conn): Promise<void> {
  try {
    const buf = new Uint8Array(8192);
    const n = await conn.read(buf);
    if (!n) return;

    const raw = new TextDecoder().decode(buf.subarray(0, n)).trim();
    let msg: Message;
    try {
      msg = JSON.parse(raw);
    } catch {
      const err = JSON.stringify({ ok: false, error: "Invalid JSON" });
      await conn.write(new TextEncoder().encode(err + "\n"));
      return;
    }

    const response = await handleMessage(msg);
    await conn.write(new TextEncoder().encode(response + "\n"));
  } catch (e) {
    log(`Connection error: ${e}`);
    try {
      const err = JSON.stringify({ ok: false, error: String(e) });
      await conn.write(new TextEncoder().encode(err + "\n"));
    } catch { /* connection dead */ }
  } finally {
    try { conn.close(); } catch { /* */ }
  }
}

// --- Main ---

async function main(): Promise<void> {
  await initLog();
  await Deno.mkdir(AGENT_DIR, { recursive: true });
  await Deno.mkdir(MOUNT_BASE, { recursive: true });

  // Clean up stale socket
  try {
    await Deno.remove(SOCKET_PATH);
  } catch { /* doesn't exist */ }

  const listener = Deno.listen({ transport: "unix", path: SOCKET_PATH });
  log(`open-agent listening on ${SOCKET_PATH}`);

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    listener.close();
    try { await Deno.remove(SOCKET_PATH); } catch { /* */ }

    // Unmount everything
    for (const [host] of mounts) {
      await unmountHost(host);
    }
    logFile?.close();
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  for await (const conn of listener) {
    handleConnection(conn); // concurrent — don't await
  }
}

main();
