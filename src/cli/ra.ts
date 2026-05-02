#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// ra — open-agent admin and diagnostic CLI
//
// Operates on the running open-agent daemon over the same Unix socket /
// TCP transport the regular r* tools use. Designed to be runnable from
// either the local Mac or a remote SSH session — same code path either
// way; the transport layer figures out where the daemon lives.

import type { Message, Response } from "../lib/messages.ts";
import { fail, formatErrorMessage, send } from "../lib/oa.ts";

const USAGE = `Usage: ra <command> [args]

Commands:
  ping              Quick liveness probe of the daemon
  status            Daemon health summary (version + mount count)
  mounts            List active mounts and their state
  reset [host]      Tear down all mounts (or just one) and purge sessions
  help              Show this help

Additional commands (doctor, logs) are coming.`;

const subcommand = Deno.args[0] ?? "";

if (
  !subcommand ||
  subcommand === "help" ||
  subcommand === "--help" ||
  subcommand === "-h"
) {
  console.log(USAGE);
  Deno.exit(0);
}

switch (subcommand) {
  case "ping":
    await runPing();
    break;
  case "status":
    await runStatus();
    break;
  case "mounts":
    await runMounts();
    break;
  case "reset":
    await runReset(Deno.args[1]);
    break;
  default:
    fail(`unknown command: ${subcommand}\n\n${USAGE}`);
}

// --- Subcommand implementations ---

async function sendOrFail(msg: Message, timeoutSec = 5): Promise<Response> {
  try {
    return await send(msg, timeoutSec);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    fail(
      `agent unreachable: ${detail}\n` +
        `  → SSH tunnel may have died. Reconnect SSH, or check the daemon is running locally.`,
    );
  }
}

async function runPing(): Promise<void> {
  // Tight timeout — ping does no I/O on the daemon side, so anything
  // beyond a couple of seconds means the transport is unhealthy.
  const response = await sendOrFail({ action: "ping" }, 3);
  if (!response.ok) fail(formatErrorMessage(response.error));
  const version = typeof response.version === "string" ? response.version : "?";
  console.log(`OK (open-agent v${version})`);
}

async function runStatus(): Promise<void> {
  const response = await sendOrFail({ action: "status" });
  if (!response.ok) fail(formatErrorMessage(response.error));
  const version = typeof response.version === "string" ? response.version : "?";
  const mounts = (response.mounts as Record<string, unknown> | undefined) ?? {};
  const count = Object.keys(mounts).length;
  console.log(
    `OK · open-agent v${version} · ${count} ${count === 1 ? "mount" : "mounts"}`,
  );
}

interface MountInfo {
  mountPoint: string;
  remoteHome: string;
  activeSessions: number;
  sessions: string[];
  pendingUnmount: boolean;
}

async function runMounts(): Promise<void> {
  const response = await sendOrFail({ action: "status" });
  if (!response.ok) fail(formatErrorMessage(response.error));
  const mounts = (response.mounts as Record<string, MountInfo> | undefined) ?? {};
  const entries = Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    console.log("No active mounts.");
    return;
  }

  const hostWidth = Math.max(4, ...entries.map(([h]) => h.length));
  const mpWidth = Math.max(11, ...entries.map(([, m]) => m.mountPoint.length));
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

  console.log(`${pad("HOST", hostWidth)}  ${pad("MOUNT POINT", mpWidth)}  SESSIONS  PENDING UNMOUNT`);
  for (const [host, info] of entries) {
    const sessions = String(info.activeSessions);
    const pending = info.pendingUnmount ? "yes" : "no";
    console.log(
      `${pad(host, hostWidth)}  ${pad(info.mountPoint, mpWidth)}  ${pad(sessions, 8)}  ${pending}`,
    );
  }
}

async function runReset(host?: string): Promise<void> {
  const response = await sendOrFail(
    host ? { action: "reset", host } : { action: "reset" },
  );
  if (!response.ok) fail(formatErrorMessage(response.error));
  const reset = (response.reset as string[] | undefined) ?? [];
  if (reset.length === 0) {
    console.log(host ? `No active mount for ${host}.` : "No active mounts to reset.");
  } else {
    console.log(`Reset ${reset.length} mount(s): ${reset.join(", ")}`);
  }
}
