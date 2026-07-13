#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

// open-agent-daemon: local daemon that receives open requests from remote
// machines via a forwarded Unix socket, manages SSHFS mounts, and opens
// files locally.

import { parseMessage } from "../lib/messages.ts";
import { createRealDeps, MountManager } from "./mount_manager.ts";
import { closeLog, initLog, log } from "./logger.ts";
import { handleMessage, type HandlerDeps } from "./handlers.ts";
import { acceptConnections } from "./accept.ts";

const VERSION = "0.7.4";

const HOME = Deno.env.get("HOME");
if (!HOME) {
  console.error("HOME environment variable is not set");
  Deno.exit(1);
}
const AGENT_DIR = `${HOME}/.local/share/open-agent`;
const SOCKET_PATH = `${AGENT_DIR}/open-agent.sock`;
const TCP_HOST = "127.0.0.1";
const TCP_PORT = 19876;
const TCP_BIND_ATTEMPTS = 3;
const TCP_BIND_RETRY_MS = 500;
const MOUNT_BASE = `${HOME}/.remote-mounts`;
const LOG_PATH = `${AGENT_DIR}/agent.log`;
const UNMOUNT_GRACE_MS = 30_000; // 30s after last session disconnects

// --- Wiring ---

const mountManager = new MountManager(
  createRealDeps(log),
  MOUNT_BASE,
  UNMOUNT_GRACE_MS,
);

const handlerDeps: HandlerDeps = {
  mountManager,
  async runCommand(cmd, args) {
    const command = new Deno.Command(cmd, { args });
    const result = await command.output();
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
  spawnCommand(cmd, _opts) {
    const command = new Deno.Command(cmd, { stdin: "piped" });
    const proc = command.spawn();
    return {
      stdin: proc.stdin,
      async output() {
        const result = await proc.output();
        return { success: result.success };
      },
    };
  },
  async copyFile(src, dest) {
    await Deno.copyFile(src, dest);
  },
  async stat(path) {
    const s = await Deno.stat(path);
    return { isDirectory: s.isDirectory };
  },
  log,
  home: HOME,
  version: VERSION,
};

// --- Socket server ---

async function handleConnection(conn: Deno.Conn): Promise<void> {
  log(`Connection received from ${conn.remoteAddr?.transport ?? "unknown"}`);
  try {
    const buf = new Uint8Array(8192);
    const n = await conn.read(buf);
    if (!n) {
      log("Connection closed with no data");
      return;
    }

    const raw = new TextDecoder().decode(buf.subarray(0, n)).trim();
    let msg;
    try {
      msg = parseMessage(JSON.parse(raw));
    } catch (e) {
      const err = JSON.stringify({
        ok: false,
        error: `Bad request: ${e instanceof Error ? e.message : e}`,
      });
      await conn.write(new TextEncoder().encode(err + "\n"));
      return;
    }

    const response = await handleMessage(msg, handlerDeps);
    await conn.write(new TextEncoder().encode(response + "\n"));
  } catch (e) {
    log(`Connection error: ${e}`);
    try {
      const err = JSON.stringify({ ok: false, error: String(e) });
      await conn.write(new TextEncoder().encode(err + "\n"));
    } catch { /* connection dead */ }
  } finally {
    try {
      conn.close();
    } catch { /* */ }
  }
}

// --- Main ---

/**
 * Bind the TCP fallback, retrying briefly. A launchd restart can race the
 * previous instance's socket teardown, and losing that race used to leave the
 * daemon with no fallback transport until the next restart.
 */
async function listenTcp(): Promise<Deno.Listener | null> {
  for (let attempt = 1; attempt <= TCP_BIND_ATTEMPTS; attempt++) {
    try {
      return Deno.listen({ hostname: TCP_HOST, port: TCP_PORT });
    } catch (e) {
      const last = attempt === TCP_BIND_ATTEMPTS;
      if (last) {
        log(`TCP fallback unavailable on ${TCP_HOST}:${TCP_PORT}: ${e}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, TCP_BIND_RETRY_MS));
    }
  }
  return null;
}

async function main(): Promise<void> {
  await initLog(AGENT_DIR, LOG_PATH);
  await Deno.mkdir(AGENT_DIR, { recursive: true });
  await Deno.mkdir(MOUNT_BASE, { recursive: true });

  // Clean up stale socket
  try {
    await Deno.remove(SOCKET_PATH);
  } catch { /* doesn't exist */ }

  const unixListener = Deno.listen({ transport: "unix", path: SOCKET_PATH });
  log(`open-agent listening on ${SOCKET_PATH}`);

  // TCP is a fallback transport; the port may legitimately be held by an
  // sshd RemoteForward when this machine is also an open-agent remote, so
  // a failed bind must not take down the Unix listener.
  const tcpListener = await listenTcp();
  if (tcpListener) log(`open-agent listening on ${TCP_HOST}:${TCP_PORT}`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    shuttingDown = true;
    log("Shutting down...");
    unixListener.close();
    tcpListener?.close();
    try {
      await Deno.remove(SOCKET_PATH);
    } catch { /* */ }
    await mountManager.unmountAll();
    closeLog();
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  const accepts = [acceptConnections(unixListener, handleConnection, log)];
  if (tcpListener) {
    accepts.push(acceptConnections(tcpListener, handleConnection, log));
  }
  await Promise.all(accepts);

  // Every listener is gone but nobody asked us to stop, so the daemon is up
  // with no way to be reached. Exit non-zero: the launchd job sets
  // KeepAlive/SuccessfulExit=false, so a clean exit here would be read as
  // "meant to stop" and the daemon would stay down until the next login.
  if (!shuttingDown) {
    log("All listeners closed unexpectedly — exiting for restart");
    closeLog();
    Deno.exit(1);
  }
}

main();
