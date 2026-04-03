#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// rop - proxy 1Password CLI operations through open-agent to the local machine
// Usage: rop read "op://vault/item/field"
//        rop run --env-file .env -- command args...
//        rop run -- command args...

import type { Message } from "../lib/messages.ts";
import { send, requireSock, checkResponse, getStringField, fail } from "../lib/oa.ts";

const USAGE = `Usage: rop [--account <account>] <subcommand> [options]

Proxy 1Password operations to your local machine where the GUI is accessible.

Global options:
  --account <account>               1Password account to use (shorthand or UUID)

Subcommands:
  read <ref>                        Read a single op:// secret reference
  run [--env-file <file>] -- <cmd>  Resolve op:// refs in env, then run command

Examples:
  rop read "op://dev/database/url"
  rop --account work read "op://dev/database/url"
  rop run -- make deploy
  rop run --env-file .env -- terraform apply
  rop run --env-file .env --env-file .env.local -- make test`;

if (Deno.args.length === 0) { console.log(USAGE); Deno.exit(0); }

// Parse global options (can appear anywhere before or after subcommand)
let account: string | undefined;
const filtered: string[] = [];
for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] === "--account") {
    i++;
    if (i >= Deno.args.length) fail("--account requires a value");
    account = Deno.args[i];
  } else {
    filtered.push(Deno.args[i]);
  }
}

const subcmd = filtered[0];

if (subcmd !== "-h" && subcmd !== "--help" && subcmd !== "help") {
  requireSock();
}
const rest = filtered.slice(1);

switch (subcmd) {
  case "read":
    await cmdRead(rest);
    break;
  case "run":
    await cmdRun(rest);
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(USAGE);
    break;
  default:
    fail(`unknown subcommand: ${subcmd}. See rop --help`);
}

// --- Subcommand: read ---

async function cmdRead(args: string[]): Promise<void> {
  if (args.length === 0) fail("read requires an op:// reference");
  const ref = args[0];
  if (!ref.startsWith("op://")) fail("reference must start with op://");

  const response = await send({ action: "op-read", ref, ...(account && { account }) }, 30);
  checkResponse(response);
  const value = getStringField(response, "value");
  await Deno.stdout.write(new TextEncoder().encode(value));
}

// --- Subcommand: run ---

async function cmdRun(args: string[]): Promise<void> {
  const envFiles: string[] = [];
  let cmdArgs: string[] = [];
  let foundSeparator = false;

  // Parse arguments
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--env-file") {
      i++;
      if (i >= args.length) fail("--env-file requires a filename");
      envFiles.push(args[i]);
    } else if (args[i] === "--") {
      foundSeparator = true;
      cmdArgs = args.slice(i + 1);
      break;
    } else {
      fail(`unexpected argument before --: ${args[i]}`);
    }
    i++;
  }

  if (!foundSeparator) fail("missing -- separator before command");
  if (cmdArgs.length === 0) fail("no command specified after --");

  // Collect op:// references from env files
  const refs: Record<string, string> = {};
  const envVars: Record<string, string> = {};

  for (const file of envFiles) {
    let text: string;
    try {
      text = Deno.readTextFileSync(file);
    } catch {
      fail(`env file not found: ${file}`);
    }
    for (const line of text.split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_]\w*)=\s*(.*)/);
      if (!match) continue;
      const key = match[1];
      let val = match[2];
      // Strip surrounding quotes
      val = val.replace(/^["']|["']$/g, "");
      if (val.startsWith("op://")) {
        refs[key] = val;
      } else {
        envVars[key] = val;
      }
    }
  }

  // Also scan current environment for op:// values
  for (const [key, val] of Object.entries(Deno.env.toObject())) {
    if (val.startsWith("op://")) {
      refs[key] = val;
    }
  }

  // If no op:// refs found, just run the command
  if (Object.keys(refs).length === 0) {
    // Set non-op env vars and exec
    for (const [k, v] of Object.entries(envVars)) {
      Deno.env.set(k, v);
    }
    const { code } = await new Deno.Command(cmdArgs[0], {
      args: cmdArgs.slice(1),
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
      env: Deno.env.toObject(),
    }).output();
    Deno.exit(code);
  }

  // Resolve op:// references via the agent
  const response = await send({ action: "op-resolve", refs, ...(account && { account }) }, 30);
  checkResponse(response);

  const resolved = response.resolved as Record<string, string> | undefined ?? {};

  // Build environment with resolved values
  const finalEnv = Deno.env.toObject();
  for (const [k, v] of Object.entries(envVars)) {
    finalEnv[k] = v;
  }
  for (const [k, v] of Object.entries(resolved)) {
    finalEnv[k] = v;
  }

  // Run the command
  const { code } = await new Deno.Command(cmdArgs[0], {
    args: cmdArgs.slice(1),
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: finalEnv,
  }).output();
  Deno.exit(code);
}
