#!/bin/sh
# oa-wrapper — busybox-style dispatcher for open-agent CLI scripts.
# This file is installed under multiple names (ropen, rcopy, etc.) in
# ~/.local/bin/. It dispatches to the matching TypeScript module based on
# the name it was invoked as.
OA_DIR="${OPEN_AGENT_DIR:-$HOME/.local/share/open-agent}"
CMD="$(basename "$0")"
exec deno run \
  --allow-read --allow-write --allow-run --allow-env \
  --allow-net=127.0.0.1:19876 \
  "$OA_DIR/src/cli/$CMD.ts" "$@"
