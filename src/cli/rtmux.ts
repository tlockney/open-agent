#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
// rtmux - thin wrapper that delegates to rproj tmux

import { dirname } from "jsr:@std/path@1/dirname";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { type CliDeps, realDeps } from "./deps.ts";

const scriptDir = dirname(fromFileUrl(import.meta.url));

export async function main(argv: string[], deps: CliDeps): Promise<void> {
  deps.exit(await deps.exec(`${scriptDir}/rproj.ts`, ["tmux", ...argv]));
}

if (import.meta.main) main(Deno.args, realDeps);
