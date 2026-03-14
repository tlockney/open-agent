# Remote Workflow Guide

A toolkit for working seamlessly across SSH sessions: open files on your local Mac, share clipboards, transfer files, access 1Password secrets, browse projects, and launch editors — all from any remote host.

## Architecture Overview

```mermaid
graph LR
    subgraph "Local Mac"
        A[open-agent daemon] -->|launchd| B[Unix socket]
        B --> C[sshfs mounts]
        B --> D[pbcopy/pbpaste]
        B --> E[open / code]
        B --> F[terminal-notifier]
        B --> G[op CLI]
    end

    subgraph "Remote Host"
        H[r* commands] -->|SSH RemoteForward| B
        I[open-agent-hook.sh] -->|session register| B
    end
```

- **open-agent** — A Deno daemon running on your local Mac. It listens on a Unix socket, manages SSHFS mounts, and executes local actions (open files, clipboard, notifications, 1Password).
- **SSH RemoteForward** — Forwards the agent's socket to `/tmp/open-agent.sock` on each remote host.
- **r\* commands** — Shell scripts installed on the remote. They send JSON messages to the forwarded socket.
- **open-agent-hook.sh** — Sourced in your remote shell profile. Registers/unregisters SSH sessions so the agent knows when to mount/unmount SSHFS.
- **rproj** — A project browser that runs on your local Mac. It discovers projects across multiple remote hosts and opens them via tmux, VS Code, or Finder.

## Prerequisites

### Local Mac

- **Deno** — `brew install deno` (runs the agent)
- **macFUSE + sshfs** — for SSHFS mounts
  ```bash
  brew install --cask macfuse
  brew install gromgit/fuse/sshfs-mac
  ```
- **socat** (recommended) — `brew install socat` (more reliable than `nc` for Unix sockets)
- **terminal-notifier** (optional) — `brew install terminal-notifier` (for `rnotify`)
- **1Password CLI** (optional) — for `rop` 1Password proxy
- **fzf** — `brew install fzf` (for `rproj` interactive selection)

### Remote Hosts

- **socat** or **nc** — at least one must be available (`brew install socat` or `apt install socat`)
- **python3** — required by `rpaste` and `rop` for JSON parsing
- **tmux** — for `rproj tmux` / `rtmux`

## Setup

### Step 1: Install open-agent on the Local Mac

**Quick install** (downloads the latest release):

```bash
curl -fsSL https://raw.githubusercontent.com/tlockney/open-agent/main/install.sh | bash
```

**From a local clone:**

```bash
git clone https://github.com/tlockney/open-agent.git
cd open-agent
./install.sh --local
```

The installer will:

- Check prerequisites (deno, sshfs, socat, terminal-notifier)
- Copy `agent.ts` to `~/.local/share/open-agent/`
- Copy all `bin/*` scripts to `~/.local/bin/`
- Copy `open-agent-hook.sh` to `~/.local/share/open-agent/`
- Create `~/.remote-mounts/` for SSHFS mount points
- Install and start a launchd daemon (`com.open-agent.daemon`)
- Migrate config from `~/.config/rproj/hosts` if present
- Verify the socket is live at `~/.local/share/open-agent/open-agent.sock`

To check if it's running later:

```bash
# Quick status via the CLI
open-agent status

# Check the socket exists
ls -la ~/.local/share/open-agent/open-agent.sock

# Check launchd status
launchctl list | grep open-agent

# View logs
cat ~/.local/share/open-agent/agent.log
cat ~/.local/share/open-agent/launchd-stderr.log
```

### Step 2: Configure SSH

Add to `~/.ssh/config` on your local Mac for each remote host:

```ssh-config
Host workmbp
    HostName workmbp.example.com
    User youruser

    # Forward the agent socket to the remote machine
    RemoteForward /tmp/open-agent.sock ~/.local/share/open-agent/open-agent.sock

    # Clean up stale socket files from prior disconnected sessions
    StreamLocalBindUnlink yes

    # Keep connections alive to reduce SSHFS mount disruptions
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

You can generate a starting point with `rproj setup` (see [rproj](#rproj) below).

**Important**: If you use SSH multiplexing (`ControlMaster`), the `RemoteForward` is only established on the **first** connection that creates the master socket. If you change SSH config, kill the existing master first:

```bash
ssh -O exit workmbp
```

### Step 3: Set Up Host Identity on Each Remote

The remote needs to know its SSH alias so the `r*` commands send the correct host identifier. There are three ways (checked in this order):

#### Option A: Identity file (recommended — no server config needed)

```bash
ssh workmbp 'mkdir -p ~/.config/open-agent && echo workmbp > ~/.config/open-agent/identity'
```

#### Option B: Environment variable via SSH `SetEnv`

Add to your local `~/.ssh/config`:

```ssh-config
Host workmbp
    SetEnv OPEN_AGENT_HOST=workmbp
```

Requires the remote sshd to accept it. Add to `/etc/ssh/sshd_config` on the remote:

```
AcceptEnv OPEN_AGENT_HOST
```

Then restart sshd.

#### Option C: Hostname fallback

If the SSH alias matches the remote's short hostname (`hostname -s`), no config is needed. The hook falls back to `$(hostname -s)` automatically.

### Step 4: Deploy Remote Scripts

Use the `open-agent` CLI to deploy all scripts to your remote hosts:

```bash
# Deploy to a single host
open-agent setup-remote workmbp

# Deploy to all hosts in your config
open-agent setup-remote all
```

This creates a tarball of the `r*` scripts, `lib/open-agent.sh`, and `open-agent-hook.sh`, then pipes it via SSH to each host. Scripts are installed to `~/.local/bin/` and the hook to `~/.local/share/open-agent/`.

Ensure `~/.local/bin` is in `PATH` on each remote:

```bash
# Add to ~/.zshrc or ~/.bashrc on the remote
export PATH="$HOME/.local/bin:$PATH"
```

### Step 5: Source the Hook on the Remote

Add to `~/.zshrc` (or `~/.bashrc`) on each remote host:

```bash
# open-agent: register SSH sessions for SSHFS mount lifecycle
[[ -f ~/.local/share/open-agent/open-agent-hook.sh ]] && source ~/.local/share/open-agent/open-agent-hook.sh
```

The hook:

- Only activates inside SSH sessions (`$SSH_CONNECTION` must be set)
- Registers the session with the local agent on shell startup (triggers SSHFS mount)
- Unregisters on shell exit (triggers unmount after 30s grace period)
- Aliases `open` to `ropen` if available
- Provides an `oa-status` function

### Step 6: Test the Connection

Start a new SSH session and verify:

```bash
ssh workmbp

# Check the socket is forwarded
ls -la /tmp/open-agent.sock

# Check agent status
oa-status

# Test opening a file
ropen ~/.zshrc
```

## Remote Commands Reference

All `r*` commands run on the **remote host** and communicate with the local open-agent via the forwarded socket at `/tmp/open-agent.sock`.

### ropen

Open files, URLs, or VS Code projects on your local Mac.

```bash
ropen README.md                      # Open with default app on local Mac
ropen -a "Marked 2" doc.md           # Open with a specific application
ropen -v ~/projects/myapp            # Open folder in local VS Code via remote-ssh
ropen https://github.com/foo/bar     # Open URL in local browser
```

When the agent socket isn't available, `ropen` falls back to the native `open` command (if on macOS).

The hook automatically aliases `open` to `ropen` in SSH sessions, so `open file.md` works transparently.

### rcopy / rpaste

Share your clipboard between remote and local machines.

```bash
# Copy to local clipboard
echo "some text" | rcopy
cat file.txt | rcopy
git diff | rcopy

# Paste from local clipboard
rpaste
rpaste > file.txt
rpaste | vim -
```

### rpush / rpull

Transfer files between remote and local machines.

```bash
# Push a remote file to the local Mac
rpush build.tar.gz                   # → local ~/Downloads/build.tar.gz
rpush -d ~/Desktop report.pdf        # → local ~/Desktop/report.pdf

# Pull a local file to the remote machine
rpull ~/Downloads/image.png          # → ./image.png (current directory)
rpull ~/Desktop/notes.md ~/docs/     # → ~/docs/notes.md
```

### rnotify

Send macOS notifications from the remote host.

```bash
rnotify "Build complete"
rnotify "CI" "All 42 tests passed"
rnotify -s Ping "Deploy" "Production deploy finished"
rnotify -u "myproject" "Tests" "Suite passed in 3m12s"
```

Options:

- `-s <sound>` — Play a sound (e.g., `Ping`, `Glass`, `Hero`)
- `-u <subtitle>` — Add a subtitle

### rop

Proxy 1Password CLI operations to your local Mac (where the 1Password GUI and biometric auth are available).

```bash
# Read a single secret
rop read "op://dev/database/url"

# Run a command with op:// references resolved from env files
rop run --env-file .env -- make deploy
rop run --env-file .env --env-file .env.local -- terraform apply

# Run a command resolving op:// values from the current environment
rop run -- command-that-needs-secrets
```

The `run` subcommand:

1. Scans `--env-file` files and the current environment for `op://` references
2. Resolves them in parallel via the local 1Password CLI
3. Exports the resolved values and runs your command

### rcode

Open a project in VS Code. Context-aware:

- **On the remote**: delegates to `ropen -v` (sends through the agent socket)
- **On the local Mac**: delegates to `rproj code` (interactive project selection)

```bash
rcode                    # Interactive project selection (local) or current dir (remote)
rcode ~/projects/myapp   # Open specific path
```

### rtmux

Thin wrapper that delegates to `rproj tmux`. Opens a tmux session on a remote host for a selected project.

```bash
rtmux                    # Interactive project + host selection
rtmux myproject          # Direct to 'myproject'
```

## open-agent CLI

The `open-agent` command manages the toolkit itself. It runs on your **local Mac**.

```bash
open-agent setup-remote workmbp     # Deploy scripts to a single remote host
open-agent setup-remote all         # Deploy to all configured hosts
open-agent status                   # Check daemon status (sessions, mounts)
open-agent update                   # Fetch and install latest GitHub release
open-agent version                  # Print version
```

### setup-remote

Reads `~/.config/open-agent/remote-hosts`, extracts unique host aliases, and deploys:

- All `r*` scripts and `lib/open-agent.sh` → `~/.local/bin/` on each remote
- `open-agent-hook.sh` → `~/.local/share/open-agent/` on each remote

Validates SSH connectivity before deploying. Prints post-deploy instructions for PATH and hook sourcing.

### update

Fetches the latest release tag from the GitHub API, downloads the release tarball, extracts it, and runs `install.sh --local` from the extracted directory.

### status

Sends a `{"action":"status"}` message to the local daemon socket and pretty-prints the response, showing active sessions, mounts, and their state.

## rproj

`rproj` is a local Mac command for browsing and opening projects across multiple remote hosts. It supports interactive selection via fzf and direct commands.

### Multi-Host Configuration

Create `~/.config/open-agent/remote-hosts` with one entry per line. Format: `alias|directory|label`

```
# ~/.config/open-agent/remote-hosts
workmbp|/Users/youruser/src/work|Work Projects
workmbp|/Users/youruser/src/personal|Personal
devbox|~/projects|Dev Server
```

- **alias** — SSH host alias (must match your `~/.ssh/config`)
- **directory** — Remote directory containing projects (each subdirectory is a project)
- **label** — Display label in the fzf picker (optional, defaults to alias)

A host can appear multiple times with different directories. Each entry becomes a separate group in the picker.

**Backward compatibility**: If `~/.config/open-agent/remote-hosts` doesn't exist, `rproj` falls back to `~/.config/rproj/hosts` (with a warning on stderr), then to the legacy `~/.config/rproj/config` file:

```bash
RPROJ_HOST="workmbp"
RPROJ_DIR="/Users/youruser/src/projects"
```

### Commands

#### Interactive mode (default)

```bash
rproj
```

1. Discovers projects from all configured hosts in parallel (3s SSH timeout per host)
2. Shows a unified fzf picker grouped by label:
   ```
   Work Projects > 📂 work
   Work Projects >   ├── api-service
   Work Projects >   └── shared-libs
   Personal > 📂 personal
   Personal >   ├── open-agent
   Personal >   └── dotfiles
   ```
3. After selecting a project, choose an action: `tmux`, `code`, or `finder`

Type across the `>` separator to fuzzy-match on label + project name (e.g., "dev ml" narrows to `Dev Server > ml-pipeline`).

#### list

```bash
rproj list                  # List all projects from all hosts
rproj l                     # Short form
rproj list -h workmbp       # Filter to a specific host
rproj list --json           # Alfred-compatible JSON output
rproj list --json -q api    # Filtered JSON output
```

#### tmux

```bash
rproj tmux                         # Interactive selection, then SSH + tmux
rproj t                            # Short form
rproj tmux -h workmbp myproject    # Direct: open tmux for 'myproject' on workmbp
```

SSHes to the selected host, `cd`s into the project, and runs `tc` (create-or-attach tmux session named after the directory).

#### code

```bash
rproj code                         # Interactive selection, then open VS Code
rproj c                            # Short form
rproj code -h workmbp myproject    # Direct: open 'myproject' in VS Code
```

Opens the project in VS Code using `code --remote ssh-remote+<host> <path>`.

#### finder

```bash
rproj finder                       # Interactive selection, then open in Finder
rproj f                            # Short form
rproj finder -h workmbp myproject  # Direct
```

Opens the project directory in Finder via SSHFS. Requires open-agent to be running.

#### setup

```bash
rproj setup
```

Prints recommended SSH config and identity file commands for all configured hosts. Informational only — doesn't modify any files.

#### status

```bash
rproj status
rproj s
```

Shows open-agent daemon status (active mounts, sessions, version).

#### open

```bash
rproj open "workmbp|/Users/youruser/src/projects/api-service"
```

Opens a project in VS Code from a `host|path` argument. Used by Alfred integration.

### Options

| Option | Description |
|--------|-------------|
| `-h`, `--host HOST` | Filter to a specific host alias |
| `-p NAME` | Project name (skip interactive selection) |
| `--json` | Output as Alfred-compatible JSON (list only) |
| `-q QUERY` | Filter by query string (list --json only) |

When using `-p` with multiple hosts configured, `--host` is required to disambiguate.

## Configuration Reference

### File Locations

| File | Purpose |
|------|---------|
| `~/.config/open-agent/remote-hosts` | Host configuration (alias, project dir, label) |
| `~/.config/open-agent/identity` | Host identity file on remotes |
| `~/.local/share/open-agent/agent.ts` | The Deno daemon |
| `~/.local/share/open-agent/open-agent.sock` | Local daemon socket |
| `~/.local/share/open-agent/open-agent-hook.sh` | Shell hook (deployed to remotes) |
| `~/.local/share/open-agent/agent.log` | Agent log output |
| `~/.local/share/open-agent/launchd-stderr.log` | Launchd stderr |
| `~/.local/bin/r*` | Remote command scripts |
| `~/.local/bin/open-agent` | CLI tool |
| `~/.local/bin/lib/open-agent.sh` | Shared library |
| `~/.remote-mounts/<host>/` | SSHFS mount points |
| `~/Library/LaunchAgents/com.open-agent.daemon.plist` | Launchd service |

### Environment Variables

| Variable | Default | Where | Description |
|----------|---------|-------|-------------|
| `OPEN_AGENT_HOST` | `workmbp` | Remote | SSH config Host alias for this remote machine |
| `OPEN_AGENT_SOCK` | `/tmp/open-agent.sock` | Remote | Path to the forwarded socket |
| `XDG_CONFIG_HOME` | `~/.config` | Both | Base directory for config files |

### Agent Constants (in `agent.ts`)

| Constant | Default | Description |
|----------|---------|-------------|
| `UNMOUNT_GRACE_MS` | `30000` | Delay before unmounting after last session exits |
| SSHFS `cache_timeout` | `120` | Metadata cache in seconds (trade freshness for speed) |

## Updating

### Update the local installation

```bash
# From the CLI (downloads latest release)
open-agent update

# Or from a local clone
cd ~/src/personal/open-agent
git pull
./install.sh --local
```

### Update remote hosts

After updating locally, redeploy to remotes:

```bash
open-agent setup-remote all
```

## Troubleshooting

### Socket not found on remote

```
ropen: agent socket not found at /tmp/open-agent.sock
```

1. **Check the agent is running locally**: `ls -la ~/.local/share/open-agent/open-agent.sock`
2. **Check SSH forwarding**: `ssh -v workmbp` — look for `Requesting forwarding of remote forward`
3. **Kill stale multiplexed connections**: `ssh -O exit workmbp` then reconnect
4. **Check `RemoteForward` is in your SSH config** for this host

### SSHFS mount failures

```bash
# Check agent logs
cat ~/.local/share/open-agent/agent.log

# Verify sshfs is installed
which sshfs

# Check existing mounts
mount | grep remote-mounts

# Force unmount a stuck mount
diskutil unmount force ~/.remote-mounts/workmbp
```

### Host identity not set

If the agent receives the wrong host identifier, SSHFS mounts will target the wrong machine.

```bash
# On the remote, check what identity the hook resolved
echo $_OA_HOST

# If wrong, create/update the identity file
echo workmbp > ~/.config/open-agent/identity
```

### open-agent not starting

```bash
# Check launchd status
launchctl list | grep open-agent

# View error logs
cat ~/.local/share/open-agent/launchd-stderr.log

# Restart manually
launchctl bootout gui/$(id -u)/com.open-agent.daemon
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.open-agent.daemon.plist
```

### sshfs not found by agent

The launchd plist needs `/opt/homebrew/bin` in its PATH environment variable. Re-run `./install.sh --local` or edit the plist manually.

### Offline hosts in rproj

If a host is unreachable, `rproj` skips it after a 3-second SSH timeout. Projects from reachable hosts still appear normally. No error is shown — the offline host's group is simply absent from the list.

### Scripts not found on remote

If `ropen` or other commands aren't found after deployment:

```bash
# Check ~/.local/bin is in PATH
echo $PATH | tr ':' '\n' | grep local

# If not, add to ~/.zshrc:
export PATH="$HOME/.local/bin:$PATH"

# Verify scripts are installed
ls -la ~/.local/bin/r*
```

### Hook not activating

The hook only runs inside SSH sessions. Verify:

```bash
# Should be non-empty in an SSH session
echo $SSH_CONNECTION

# Check the hook file exists
ls -la ~/.local/share/open-agent/open-agent-hook.sh

# Check it's sourced in your shell profile
grep open-agent ~/.zshrc
```
