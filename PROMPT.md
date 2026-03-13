# Open-Agent: Claude Code Session Prompt

## Context

I'm building `open-agent`, a tool that lets me `open` files on my local Mac from SSH sessions on a remote Mac workstation. The architecture:

1. **Local agent daemon** (Deno/TypeScript) — runs on my personal Mac, listens on a Unix domain socket, manages SSHFS mounts, executes `open` and `code --remote` commands locally.
2. **SSH RemoteForward** — forwards the agent's Unix socket to the remote machine so remote scripts can talk to it.
3. **Remote wrapper (`ropen`)** — bash script on the remote machine that sends JSON messages over the forwarded socket.
4. **Shell hook** — sourced in remote `.zshrc`, registers/unregisters SSH sessions for mount lifecycle tracking.
5. **SSHFS mount management** — mounts remote `$HOME` on first SSH session, reference-counts sessions, unmounts with a 30s grace period after the last session disconnects.

The initial implementation is in this repo. It was generated in a chat session and needs review, refinement, and integration work.

## My environment

- **Personal Mac** (local): runs the agent daemon, has Deno, macFUSE/sshfs, socat installed. This is where I run Claude Code.
- **Work Mac** (remote): where I SSH into. Host alias is `workmbp` in my SSH config. My source code lives under `/Users/thomas.lockney/src/metron/`.
- I use zsh on both machines.
- I have an existing `rproj` script (attached below) that handles remote project selection and opening via VS Code (`code --remote`) and tmux. It lives in `~/bin/rproj` with thin wrappers `rcode` and `rtmux`.
- I have an Alfred workflow for quick VS Code project opens that calls `rproj open`.
- I prefer Deno/TypeScript for personal tooling.
- I use launchd for local daemons on macOS.

## What needs doing

### Phase 1: Review and harden the agent

- Review `agent.ts` for correctness, edge cases, error handling.
- The `Deno.listen({ transport: "unix" })` API and connection handling — verify against current Deno stable APIs.
- SSHFS mount/unmount robustness: what happens with concurrent requests during a remount? Race conditions on session tracking?
- The 3-second stat timeout for mount health checks — is this the right approach?
- Consider whether the agent should also support a TCP listener (localhost-only) as a fallback for environments where Unix socket forwarding doesn't work.
- Add a `--version` or status endpoint.

### Phase 2: Review and harden remote scripts

- `ropen`: verify the JSON construction is safe for all path patterns. The `python3 -c` JSON escaping works but adds a subprocess per invocation — consider alternatives.
- `open-agent-hook.sh`: the trap-on-EXIT approach for disconnect notification — does this fire reliably for all shell exit scenarios (ssh disconnect, `exit`, ctrl-d, terminal close)?
- Should the hook attempt periodic reconnect registration in case the socket was re-forwarded?

### Phase 3: Integration with rproj

- Add an `open` subcommand to `rproj` that uses the agent to open files/directories on the local machine (via SSHFS + `open`), distinct from the existing `code` subcommand that uses VS Code remote-ssh.
- Consider whether `rproj` should have a way to check agent status.
- The Alfred workflow could potentially gain an "Open in Finder" option alongside VS Code.

### Phase 4: Install and test

- Run the install script, verify launchd setup.
- Test the full flow: SSH in, verify socket forwarding, test `ropen` with various file types.
- Document any issues found.

## Existing rproj script

See `ref/rproj` in this repo — the bootstrap script copies it from `~/bin/rproj`. This is the script that open-agent should eventually integrate with (Phase 3). Don't modify it yet — just be aware of its structure and subcommand pattern.

## Preferences

- Keep the code minimal and clear. No unnecessary abstractions.
- Deno for the agent, bash for the shell scripts.
- I'd rather have good error messages than silent failures.
- Comments should explain *why*, not *what*.
- I'll be testing interactively as we go, so expect me to report back with results.

Start with Phase 1 — review `agent.ts` and propose improvements. Don't rewrite wholesale; identify specific issues and fix them incrementally.
