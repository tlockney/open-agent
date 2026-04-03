#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=unix,127.0.0.1:19876

// open-agent-daemon: local daemon that receives open requests from remote
// machines via a forwarded Unix socket, manages SSHFS mounts, and opens
// files locally.

import { type Message, parseMessage } from "../lib/messages.ts";
import { translatePath } from "../lib/path_utils.ts";

const VERSION = "0.3.0";

const HOME = Deno.env.get("HOME");
if (!HOME) {
  console.error("HOME environment variable is not set");
  Deno.exit(1);
}
const AGENT_DIR = `${HOME}/.local/share/open-agent`;
const SOCKET_PATH = `${AGENT_DIR}/open-agent.sock`;
const TCP_HOST = "127.0.0.1";
const TCP_PORT = 19876;
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
  logFile?.writeSync(new TextEncoder().encode(line));
}

// --- Types ---

interface MountState {
  host: string;
  remoteHome: string;
  mountPoint: string;
  sessions: Set<string>;
  unmountTimer?: number;
}

const mounts = new Map<string, MountState>();

// Serialize mount operations per-host to prevent concurrent sshfs spawns
const mountLocks = new Map<string, Promise<MountState>>();

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

function ensureMount(host: string, remoteHome: string): Promise<MountState> {
  // Serialize per-host so concurrent requests don't spawn parallel sshfs processes.
  // Use .catch() on the chain so a prior failure doesn't block subsequent attempts,
  // and on the stored promise so rejections don't go unhandled.
  const existing = mountLocks.get(host) ?? Promise.resolve(undefined as unknown as MountState);
  const next = existing.catch(() => undefined as unknown as MountState).then(() => doMount(host, remoteHome));
  const guarded = next.catch((e: unknown) => { throw e; });
  mountLocks.set(host, guarded);
  guarded.catch(() => { /* prevent unhandled rejection on the stored promise */ });
  guarded.finally(() => {
    if (mountLocks.get(host) === guarded) mountLocks.delete(host);
  });
  return next;
}

async function doMount(host: string, remoteHome: string): Promise<MountState> {
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

    case "copy": {
      const cmd = new Deno.Command("pbcopy", { stdin: "piped" });
      const proc = cmd.spawn();
      const writer = proc.stdin.getWriter();
      await writer.write(new TextEncoder().encode(msg.content));
      await writer.close();
      const { success } = await proc.output();
      if (!success) {
        return JSON.stringify({ ok: false, error: "pbcopy failed" });
      }
      log(`Copied ${msg.content.length} bytes to clipboard`);
      return JSON.stringify({ ok: true, bytes: msg.content.length });
    }

    case "paste": {
      const cmd = new Deno.Command("pbpaste");
      const { success, stdout } = await cmd.output();
      if (!success) {
        return JSON.stringify({ ok: false, error: "pbpaste failed" });
      }
      const content = new TextDecoder().decode(stdout);
      return JSON.stringify({ ok: true, content });
    }

    case "notify": {
      const args = ["-title", msg.title];
      if (msg.message) args.push("-message", msg.message);
      if (msg.subtitle) args.push("-subtitle", msg.subtitle);
      if (msg.sound) args.push("-sound", msg.sound);

      const cmd = new Deno.Command("terminal-notifier", { args });
      const result = await cmd.output();
      if (!result.success) {
        const err = new TextDecoder().decode(result.stderr);
        return JSON.stringify({ ok: false, error: `notification failed: ${err}` });
      }
      log(`Notification: ${msg.title}`);
      return JSON.stringify({ ok: true });
    }

    case "open-url": {
      // Validate it looks like a URL before passing to open
      if (!/^https?:\/\//i.test(msg.url)) {
        return JSON.stringify({ ok: false, error: "Only http/https URLs are supported" });
      }
      log(`Opening URL: ${msg.url}`);
      const cmd = new Deno.Command("open", { args: [msg.url] });
      const result = await cmd.output();
      if (!result.success) {
        const err = new TextDecoder().decode(result.stderr);
        return JSON.stringify({ ok: false, error: `open URL failed: ${err}` });
      }
      return JSON.stringify({ ok: true });
    }

    case "push": {
      // Copy a remote file to the local machine
      const state = await ensureMount(msg.host, msg.remoteHome);
      const srcPath = translatePath(msg.path, state);
      const dest = msg.dest ?? `${HOME}/Downloads`;
      const fileName = srcPath.split("/").pop()!;
      const destPath = `${dest}/${fileName}`;

      log(`Push: ${srcPath} → ${destPath}`);
      await Deno.copyFile(srcPath, destPath);
      return JSON.stringify({ ok: true, localPath: destPath });
    }

    case "pull": {
      // Copy a local file to the remote machine via SSHFS
      const state = await ensureMount(msg.host, msg.remoteHome);
      const destMountPath = translatePath(msg.remoteDest, state);
      const fileName = msg.localPath.split("/").pop()!;

      // If remoteDest is a directory, append the filename
      let finalDest = destMountPath;
      try {
        const stat = await Deno.stat(destMountPath);
        if (stat.isDirectory) {
          finalDest = `${destMountPath}/${fileName}`;
        }
      } catch {
        // Destination doesn't exist on mount — treat as full file path
      }

      log(`Pull: ${msg.localPath} → ${finalDest}`);
      await Deno.copyFile(msg.localPath, finalDest);
      return JSON.stringify({ ok: true, remotePath: msg.remoteDest.endsWith("/") ? `${msg.remoteDest}${fileName}` : msg.remoteDest });
    }

    case "op-read": {
      // Resolve a single op:// reference via the local 1Password CLI
      log(`op-read: resolving reference`); // deliberately not logging the ref or value
      const opArgs = [...(msg.account ? ["--account", msg.account] : []), "read", msg.ref];
      const cmd = new Deno.Command("op", { args: opArgs });
      const result = await cmd.output();
      if (!result.success) {
        const err = new TextDecoder().decode(result.stderr).trim();
        return JSON.stringify({ ok: false, error: `op read failed: ${err}` });
      }
      const value = new TextDecoder().decode(result.stdout).trim();
      return JSON.stringify({ ok: true, value });
    }

    case "op-resolve": {
      // Resolve multiple op:// references in parallel
      log(`op-resolve: resolving ${Object.keys(msg.refs).length} references`);
      const resolved: Record<string, string> = {};
      const errors: string[] = [];

      const entries = Object.entries(msg.refs);
      const accountArgs = msg.account ? ["--account", msg.account] : [];
      const results = await Promise.all(
        entries.map(async ([key, ref]) => {
          const cmd = new Deno.Command("op", { args: [...accountArgs, "read", ref] });
          const result = await cmd.output();
          if (!result.success) {
            const err = new TextDecoder().decode(result.stderr).trim();
            return { key, error: err };
          }
          return { key, value: new TextDecoder().decode(result.stdout).trim() };
        })
      );

      for (const r of results) {
        if ("error" in r) {
          errors.push(`${r.key}: ${r.error}`);
        } else {
          resolved[r.key] = r.value;
        }
      }

      if (errors.length > 0) {
        return JSON.stringify({ ok: false, error: `Failed to resolve: ${errors.join("; ")}` });
      }
      return JSON.stringify({ ok: true, resolved });
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
      return JSON.stringify({ ok: true, version: VERSION, mounts: status });
    }
  }
}

// --- Socket server ---

async function handleConnection(conn: Deno.Conn): Promise<void> {
  log(`Connection received from ${conn.remoteAddr?.transport ?? "unknown"}`);
  try {
    const buf = new Uint8Array(8192);
    const n = await conn.read(buf);
    if (!n) { log("Connection closed with no data"); return; }

    const raw = new TextDecoder().decode(buf.subarray(0, n)).trim();
    let msg: Message;
    try {
      msg = parseMessage(JSON.parse(raw));
    } catch (e) {
      const err = JSON.stringify({ ok: false, error: `Bad request: ${e instanceof Error ? e.message : e}` });
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

async function acceptConnections(listener: Deno.Listener): Promise<void> {
  try {
    for await (const conn of listener) {
      handleConnection(conn).catch((e) => log(`Unhandled connection error: ${e}`));
    }
  } catch (e) {
    log(`Listener error: ${e}`);
  }
}

async function main(): Promise<void> {
  await initLog();
  await Deno.mkdir(AGENT_DIR, { recursive: true });
  await Deno.mkdir(MOUNT_BASE, { recursive: true });

  // Clean up stale socket
  try {
    await Deno.remove(SOCKET_PATH);
  } catch { /* doesn't exist */ }

  const unixListener = Deno.listen({ transport: "unix", path: SOCKET_PATH });
  log(`open-agent listening on ${SOCKET_PATH}`);

  const tcpListener = Deno.listen({ hostname: TCP_HOST, port: TCP_PORT });
  log(`open-agent listening on ${TCP_HOST}:${TCP_PORT}`);

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    unixListener.close();
    tcpListener.close();
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

  await Promise.all([
    acceptConnections(unixListener),
    acceptConnections(tcpListener),
  ]);
}

main();
