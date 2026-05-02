#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// ra — open-agent admin and diagnostic CLI
//
// Operates on the running open-agent daemon over the same Unix socket /
// TCP transport the regular r* tools use. Designed to be runnable from
// either the local Mac or a remote SSH session — same code path either
// way; the transport layer figures out where the daemon lives.

import { existsSync } from "jsr:@std/fs@1/exists";
import type { Message, Response } from "../lib/messages.ts";
import {
  fail,
  formatErrorMessage,
  HOST,
  send,
  SOCK,
  TCP_HOST,
  TCP_PORT,
} from "../lib/oa.ts";

const USAGE = `Usage: ra <command> [args]

Commands:
  ping              Quick liveness probe of the daemon
  status            Daemon health summary (version + mount count)
  mounts            List active mounts and their state
  reset [host]      Tear down all mounts (or just one) and purge sessions
  doctor            Full diagnostic: transport, daemon, per-mount probes
  help              Show this help`;

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
  case "doctor":
    await runDoctor();
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

interface DoctorMountInfo {
  mountPoint: string;
  remoteHome: string;
  responsive: boolean;
  activeSessions: number;
  pendingUnmount: boolean;
}

async function runDoctor(): Promise<void> {
  console.log("open-agent doctor");
  console.log("");

  // Client-side transport info — visible regardless of daemon state.
  console.log("Transport:");
  console.log(`  socket:   ${SOCK} ${existsSync(SOCK) ? "(present)" : "(missing)"}`);
  console.log(`  tcp:      ${TCP_HOST}:${TCP_PORT}`);
  console.log(`  host id:  ${HOST}`);
  console.log("");

  // Daemon reachability via ping.
  const pingStart = Date.now();
  let pingOk = false;
  let pingDetail = "";
  let version = "?";
  try {
    const r = await send({ action: "ping" }, 3);
    if (r.ok) {
      pingOk = true;
      version = typeof r.version === "string" ? r.version : "?";
    } else {
      pingDetail = formatErrorMessage(r.error);
    }
  } catch (e) {
    pingDetail = e instanceof Error ? e.message : String(e);
  }
  const pingMs = Date.now() - pingStart;

  if (pingOk) {
    console.log(`Daemon: ✓ reachable (${pingMs}ms, v${version})`);
  } else {
    console.log(`Daemon: ✗ unreachable — ${pingDetail}`);
    console.log("");
    console.log("→ Reconnect SSH (if remote) or check the daemon launchd service.");
    Deno.exit(1);
  }

  // Per-mount diagnostic probe.
  let docResp: Response;
  try {
    docResp = await send({ action: "doctor" }, 10);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.log(`Mounts: ✗ probe failed — ${detail}`);
    Deno.exit(1);
  }
  if (!docResp.ok) {
    console.log(`Mounts: ✗ probe failed — ${formatErrorMessage(docResp.error)}`);
    Deno.exit(1);
  }

  const mounts = (docResp.mounts as Record<string, DoctorMountInfo> | undefined) ??
    {};
  const entries = Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    console.log("Mounts: (none active)");
    return;
  }

  console.log(`Mounts:`);
  for (const [host, info] of entries) {
    const tag = info.responsive ? "✓" : "✗";
    let detail: string;
    if (info.responsive) {
      const session = info.activeSessions === 1 ? "session" : "sessions";
      detail = `${info.activeSessions} ${session}`;
      if (info.pendingUnmount) detail += ", pending unmount";
    } else {
      detail = `unresponsive — try 'ra reset ${host}'`;
    }
    console.log(`  ${tag} ${host}: ${info.mountPoint} (${detail})`);
  }
}
