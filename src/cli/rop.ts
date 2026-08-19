#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
// rop - proxy 1Password CLI operations through open-agent to the local machine
// Usage: rop read "op://vault/item/field"
//        rop run --env-file .env -- command args...
//        rop run -- command args...

import {
  CliError,
  extractAccount,
  parseEnvLine,
  parseReadRef,
  splitRunArgs,
} from "./args.ts";
import { type CliDeps, realDeps } from "./deps.ts";

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

export async function main(argv: string[], deps: CliDeps): Promise<void> {
  if (argv.length === 0) {
    console.log(USAGE);
    deps.exit(0);
  }

  // Parse global options (can appear anywhere before or after subcommand)
  let account: string | undefined;
  let filtered: string[];
  try {
    const globals = extractAccount(argv);
    account = globals.account;
    filtered = globals.rest;
  } catch (e) {
    if (e instanceof CliError) deps.fail(e.message);
    throw e;
  }

  const subcmd = filtered[0];
  const isHelp = subcmd === "-h" || subcmd === "--help" || subcmd === "help";

  if (!isHelp && !deps.isRemoteSession()) {
    // Local Mac — the real `op` CLI is available, so delegate verbatim. op
    // does its own op:// resolution; --account passes straight through.
    // Help still falls through to rop's own USAGE below.
    deps.exit(await deps.exec("op", argv));
  }

  if (!isHelp) {
    deps.requireSock();
  }
  const rest = filtered.slice(1);

  switch (subcmd) {
    case "read":
      await cmdRead(rest, account, deps);
      break;
    case "run":
      await cmdRun(rest, account, deps);
      break;
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      break;
    default:
      deps.fail(`unknown subcommand: ${subcmd}. See rop --help`);
  }
}

// --- Subcommand: read ---

async function cmdRead(
  args: string[],
  account: string | undefined,
  deps: CliDeps,
): Promise<void> {
  let ref: string;
  try {
    ref = parseReadRef(args);
  } catch (e) {
    if (e instanceof CliError) deps.fail(e.message);
    throw e;
  }

  const response = await deps.send({
    action: "op-read",
    ref,
    ...(account && { account }),
  }, 30);
  deps.checkResponse(response);
  const value = deps.getStringField(response, "value");
  await deps.stdout.write(new TextEncoder().encode(value));
}

// --- Subcommand: run ---

async function cmdRun(
  args: string[],
  account: string | undefined,
  deps: CliDeps,
): Promise<void> {
  let envFiles: string[];
  let cmdArgs: string[];
  try {
    ({ envFiles, cmdArgs } = splitRunArgs(args));
  } catch (e) {
    if (e instanceof CliError) deps.fail(e.message);
    throw e;
  }

  // Collect op:// references from env files
  const refs: Record<string, string> = {};
  const envVars: Record<string, string> = {};

  for (const file of envFiles) {
    let text: string;
    try {
      text = deps.readTextFileSync(file);
    } catch {
      deps.fail(`env file not found: ${file}`);
    }
    for (const line of text.split("\n")) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      if (parsed.isRef) {
        refs[parsed.key] = parsed.value;
      } else {
        envVars[parsed.key] = parsed.value;
      }
    }
  }

  // Also scan current environment for op:// values
  for (const [key, val] of Object.entries(deps.env.toObject())) {
    if (val.startsWith("op://")) {
      refs[key] = val;
    }
  }

  // If no op:// refs found, just run the command
  if (Object.keys(refs).length === 0) {
    // Set non-op env vars and exec
    for (const [k, v] of Object.entries(envVars)) {
      deps.env.set(k, v);
    }
    deps.exit(await deps.exec(cmdArgs[0], cmdArgs.slice(1)));
  }

  // Resolve op:// references via the agent
  const response = await deps.send({
    action: "op-resolve",
    refs,
    ...(account && { account }),
  }, 30);
  deps.checkResponse(response);

  const resolved = response.resolved as Record<string, string> | undefined ??
    {};

  // Build environment with resolved values
  const finalEnv = deps.env.toObject();
  for (const [k, v] of Object.entries(envVars)) {
    finalEnv[k] = v;
  }
  for (const [k, v] of Object.entries(resolved)) {
    finalEnv[k] = v;
  }

  // Run the command
  deps.exit(await deps.exec(cmdArgs[0], cmdArgs.slice(1), finalEnv));
}

if (import.meta.main) main(Deno.args, realDeps);
