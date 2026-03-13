# open-agent

Open remote files on your local machine over SSH.

A lightweight daemon that runs on your personal Mac, receives open requests from a remote machine via SSH-forwarded Unix socket, and manages SSHFS mounts to provide transparent local file access.

## How it works

```
Local Mac (personal)                      Remote Mac (work)
┌─────────────────────┐                  ┌──────────────────────┐
│ open-agent daemon    │  SSH RemoteForward  │                      │
│  • listens on sock   │◄────────────────│ ropen (alias: open)  │
│  • manages SSHFS     │  Unix socket    │  • sends JSON request │
│  • calls /usr/bin/open│                 │  • falls back to native│
│  • calls code --remote│                 │                      │
└─────────────────────┘                  └──────────────────────┘
        │
        ▼
 ~/.remote-mounts/work/   ← SSHFS mount of remote $HOME
```

1. SSH session forwards a Unix socket from local → remote
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
- socat (recommended: `brew install socat`)

**Remote (work) machine:**
- socat or netcat with Unix socket support
- python3 (for JSON escaping in shell scripts — available on macOS by default)

## Install

```bash
git clone <this-repo> ~/open-agent   # or wherever
cd ~/open-agent
chmod +x install.sh
./install.sh
```

The install script handles the local side. Follow its printed instructions for remote setup.

## Usage

From an SSH session on the remote machine:

```bash
# Open a file with default app
ropen ~/docs/report.md

# Open with specific app
ropen -a "Marked 2" ~/docs/report.md

# Open a project in local VS Code (via remote-ssh)
ropen -v ~/projects/myapp

# Works as 'open' alias (set up by the shell hook)
open ~/docs/report.md
```

Check agent status:

```bash
oa-status   # shows mount state and active sessions
```

## Configuration

Environment variables (set on the remote machine):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPEN_AGENT_HOST` | `work` | SSH config Host alias for the remote machine |
| `OPEN_AGENT_SOCK` | `/tmp/open-agent.sock` | Path to the forwarded socket |

Agent constants (in `agent.ts`):

| Constant | Default | Description |
|----------|---------|-------------|
| `UNMOUNT_GRACE_MS` | `30000` | Delay before unmounting after last session exits |
| SSHFS `cache_timeout` | `120` | Metadata cache in seconds (trade freshness for speed) |

## Limitations

- **Paths must be under remote `$HOME`.** The SSHFS mount covers the home directory. Files elsewhere (e.g., `/opt/...`) aren't accessible.
- **File-level latency.** SSHFS reads happen over SSH. Small files (markdown, configs) are fast. Large binary files will be slow to open.
- **Stale mount recovery.** If the SSHFS mount hangs (e.g., after network loss), the agent attempts remount on next request. During a hang, the 3-second stat timeout prevents the agent from blocking indefinitely, but the hung mount may need manual `umount -f`.
- **Single-user.** The forwarded socket is user-scoped. No auth is performed on requests — anyone with access to the socket on the remote machine can trigger opens.
- **macOS only.** Both sides assume macOS (`open` command, `diskutil`, launchd). Adapting for Linux would need `xdg-open` and a systemd unit.

## Troubleshooting

**Socket not found on remote:** Check that SSH config has `RemoteForward` and `StreamLocalBindUnlink yes`. Reconnect SSH.

**Mount failures:** Verify sshfs works manually: `sshfs work:~ /tmp/test-mount`. Check macFUSE is installed.

**Agent not running:** `launchctl list | grep open-agent`. Check logs at `~/.local/share/open-agent/launchd-stderr.log`.

**Stale SSHFS mount:** `umount -f ~/.remote-mounts/work` or `diskutil unmount force ~/.remote-mounts/work`.
