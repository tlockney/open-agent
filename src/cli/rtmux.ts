#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
// rtmux - thin wrapper that delegates to rproj tmux

import { dirname } from "jsr:@std/path@1/dirname";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";

const scriptDir = dirname(fromFileUrl(import.meta.url));
const { code } = await new Deno.Command(`${scriptDir}/rproj.ts`, {
  args: ["tmux", ...Deno.args],
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
}).output();
Deno.exit(code);
