#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
// rcode - open a project in VS Code via remote-ssh
//
// Local: delegates to rproj code (interactive project selection)
// Remote (SSH session): sends open-vscode action through the agent socket

import { dirname } from "jsr:@std/path@1/dirname";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { type CliDeps, realDeps } from "./deps.ts";

const scriptDir = dirname(fromFileUrl(import.meta.url));

export async function main(argv: string[], deps: CliDeps): Promise<void> {
  const target = argv[0] ?? ".";

  if (deps.isRemoteSession()) {
    // On the remote — use ropen -v
    deps.exit(await deps.exec(`${scriptDir}/ropen.ts`, ["-v", target]));
  } else {
    // On the local Mac — delegate to rproj code
    deps.exit(await deps.exec(`${scriptDir}/rproj.ts`, ["code", ...argv]));
  }
}

if (import.meta.main) main(Deno.args, realDeps);
