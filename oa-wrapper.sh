#!/bin/sh
# oa-wrapper — busybox-style dispatcher for open-agent CLI scripts.
# This file is installed under multiple names (ropen, rcopy, etc.) in
# ~/.local/bin/. It dispatches to the matching TypeScript module based on
# the name it was invoked as.
OA_DIR="${OPEN_AGENT_DIR:-$HOME/.local/share/open-agent}"
CMD="$(basename "$0")"
# Unscoped --allow-net: Unix socket connects need a net grant on Deno >= 2.9,
# but the scoped unix:<path> syntax is a parse error on older Deno, and this
# wrapper runs on remotes with mixed Deno versions.
exec deno run \
  --allow-read --allow-write --allow-run --allow-env \
  --allow-net \
  "$OA_DIR/src/cli/$CMD.ts" "$@"
