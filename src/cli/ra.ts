#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// ra — open-agent admin and diagnostic CLI
//
// Operates on the running open-agent daemon over the same Unix socket /
// TCP transport the regular r* tools use. Designed to be runnable from
// either the local Mac or a remote SSH session — same code path either
// way; the transport layer figures out where the daemon lives.

import type { Response } from "../lib/messages.ts";
import { fail, formatErrorMessage, send } from "../lib/oa.ts";

const USAGE = `Usage: ra <command>

Commands:
  ping      Quick liveness probe of the open-agent daemon
  help      Show this help

Additional commands (mounts, status, reset, doctor, logs) are coming.`;

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
  default:
    fail(`unknown command: ${subcommand}\n\n${USAGE}`);
}

async function runPing(): Promise<void> {
  let response: Response;
  try {
    // Tight timeout — ping does no I/O on the daemon side, so anything
    // beyond a couple of seconds means the transport is unhealthy.
    response = await send({ action: "ping" }, 3);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    fail(
      `agent unreachable: ${detail}\n` +
        `  → SSH tunnel may have died. Reconnect SSH, or check the daemon is running locally.`,
    );
  }

  if (!response.ok) {
    fail(formatErrorMessage(response.error));
  }

  const version = typeof response.version === "string" ? response.version : "?";
  console.log(`OK (open-agent v${version})`);
}
