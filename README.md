# open-agent

Bridge your local Mac's capabilities to remote SSH sessions.

A lightweight Deno daemon that runs on your personal Mac, receives requests from a remote machine via SSH-forwarded Unix socket. Opens files, transfers files, shares clipboard, sends notifications, opens URLs, and proxies 1Password CLI — all from the remote terminal.

## How it works

```mermaid
flowchart LR
    subgraph remote["Remote Mac (work)"]
        ropen["ropen / rcode"]
        tools["rcopy / rpaste\nrnotify / rpush / rpull\nrop"]
        hook["shell hook\nconnect/disconnect"]
    end

    subgraph local["Local Mac (personal)"]
        agent["open-agent daemon"]
        open["/usr/bin/open\ncode --remote"]
        clip["clipboard\nnotifications\nURLs"]
        op["1Password CLI"]
        mount["~/.remote-mounts/\nSSHFS mount"]
    end

    ropen -- "JSON over\nSSH-forwarded\nUnix socket" --> agent
    tools -- "JSON over\nUnix socket" --> agent
    hook -- "session\nlifecycle" --> agent
    agent --> open
    agent --> clip
    agent --> op
    agent -- "mounts remote $HOME\non first request" --> mount
```

1. SSH session forwards a Unix socket from local to remote
2. Shell hook on remote registers session with the agent
3. Agent mounts remote `$HOME` via SSHFS on first session (or reuses existing mount)
4. `ropen README.md` sends a request over the socket
5. Agent translates the remote path to the SSHFS mount path, calls `open` locally
6. On last session disconnect (+ 30s grace period), the SSHFS mount is cleaned up

## Requirements

**Local (personal) machine:**

- macOS
- [Deno](https://deno.land/) runtime
- [macFUSE](https://osxfuse.github.io/) + sshfs (`brew install --cask macfuse && brew install gromgit/fuse/sshfs-mac`)
- [terminal-notifier](https://github.com/julienXX/terminal-notifier) for notifications (`brew install terminal-notifier`)
- [1Password CLI](https://developer.1password.com/docs/cli/) for `rop` proxy (optional, `brew install --cask 1password-cli`)
- socat recommended (`brew install socat`), falls back to netcat

**Remote (work) machine:**

- socat or netcat with Unix socket support

## Install

```bash
git clone <this-repo>
cd open-agent
./install.sh
```

The install script:

- Checks prerequisites (deno, sshfs, socat)
- Copies `agent.ts` to `~/.local/share/open-agent/`
- Installs and starts a launchd service
- Prints SSH config to add (`RemoteForward` + `StreamLocalBindUnlink`)

Remote-side scripts (`ropen`, `open-agent-hook.sh`) are deployed separately via [yadm](https://yadm.io/) dotfiles. See the repo layout below.

## Repo layout

```
open-agent/              ← this repo (agent daemon + install infrastructure)
  agent.ts               — the Deno daemon
  com.open-agent.daemon.plist — launchd service template
  install.sh             — local install script
  ssh_config.example     — SSH config additions
  ropen                  — remote open wrapper (canonical copy; deployed via yadm)
  open-agent-hook.sh     — shell session hook (canonical copy; deployed via yadm)
```

## Usage

From an SSH session on the remote machine:

```bash
# Open a file with default app
ropen ~/docs/report.md

# Open with specific app
ropen -a "Marked 2" ~/docs/report.md

# Open a project in local VS Code (via remote-ssh)
ropen -v ~/projects/myapp

# Open a URL in the local browser
ropen https://example.com

# Works as 'open' alias (set up by the shell hook)
open ~/docs/report.md

# Check agent status
oa-status

# Clipboard bridge
echo "hello" | rcopy        # copy to local clipboard
rpaste                      # paste from local clipboard

# Local notifications
rnotify "Build complete"
rnotify -t "Deploy" -m "Deployed to staging" -s default

# File transfer
rpush build.tar.gz           # push file to local ~/Downloads
rpush -d ~/Desktop file.pdf  # push to specific local directory
rpull ~/Downloads/image.png  # pull file from local to remote cwd

# 1Password CLI proxy
rop read "op://vault/item/field"
rop run --env-file .env -- make deploy

# SSH-aware VS Code wrapper
rcode .                      # opens in local VS Code via remote-ssh
```

From the local machine via rproj:

```bash
# Open a project in Finder via SSHFS
rproj finder myproject
rproj f                    # interactive selection

# Check agent status
rproj status
rproj s
```

## Configuration

Environment variables (set on the remote machine):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPEN_AGENT_HOST` | `workmbp` | SSH config Host alias for the remote machine |
| `OPEN_AGENT_SOCK` | `/tmp/open-agent.sock` | Path to the forwarded socket |

Agent constants (in `agent.ts`):

| Constant | Default | Description |
|----------|---------|-------------|
| `UNMOUNT_GRACE_MS` | `30000` | Delay before unmounting after last session exits |
| SSHFS `cache_timeout` | `120` | Metadata cache in seconds (trade freshness for speed) |

## Limitations

- **Paths must be under remote `$HOME`.** The SSHFS mount covers the home directory only.
- **File-level latency.** SSHFS reads happen over SSH. Small files are fast; large binaries will be slow.
- **Stale mount recovery.** If the SSHFS mount hangs, the agent attempts remount on next request. The 3-second stat timeout prevents indefinite blocking, but a hung mount may need manual `umount -f`.
- **macOS only.** Both sides assume macOS (`open`, `diskutil`, launchd).

## Troubleshooting

**Socket not found on remote:** Verify SSH config has `RemoteForward` and `StreamLocalBindUnlink yes`. If using `ControlMaster`, kill the control socket (`ssh -O exit workmbp`) and reconnect.

**Mount failures:** Verify sshfs works manually: `sshfs workmbp:~ /tmp/test-mount`. Check that macFUSE kernel extension is loaded.

**Agent not running:** `launchctl list | grep open-agent`. Check logs: `cat ~/.local/share/open-agent/launchd-stderr.log`.

**sshfs not found by agent:** The launchd plist needs `/opt/homebrew/bin` in its PATH environment variable. Re-run `install.sh` or edit the plist manually.

**Stale SSHFS mount:** `umount -f ~/.remote-mounts/workmbp` or `diskutil unmount force ~/.remote-mounts/workmbp`.
