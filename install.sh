#!/bin/bash
# install.sh — install open-agent on a Mac
#
# Source:
#   curl -fsSL <url> | bash    — downloads latest release, then runs --local
#   ./install.sh --local       — installs from the current directory
#
# Configuration:
#   (default)      full install: CLI + daemon under launchd. Needs sshfs,
#                  because the daemon is what mounts remote filesystems.
#   --no-daemon    client-only: the r* commands, no daemon and no launchd
#                  job. Skips the sshfs and terminal-notifier checks, since
#                  both are only used daemon-side. For a machine that talks
#                  to a daemon elsewhere over the SSH tunnel.

set -euo pipefail

REPO_OWNER="tlockney"
REPO_NAME="open-agent"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# --- Argument parsing ---

LOCAL=0
WITH_DAEMON=1

for arg in "$@"; do
    case "$arg" in
        --local)     LOCAL=1 ;;
        --no-daemon) WITH_DAEMON=0 ;;
        -h|--help)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) fail "Unknown option: $arg (see --help)" ;;
    esac
done

# --- curl | sh mode (default) ---

if [[ $LOCAL -eq 0 ]]; then
    # Platform check
    if [[ "$(uname -s)" != "Darwin" ]]; then
        fail "open-agent is macOS-only. On Linux, use 'open-agent setup-remote' from your Mac to deploy remote scripts."
    fi

    echo "Installing open-agent..."
    echo ""

    # Fetch latest release tag
    LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest" \
        | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')

    if [[ -z "$LATEST_TAG" ]]; then
        fail "Could not fetch latest release from GitHub. Check your network and try again."
    fi

    info "Latest release: $LATEST_TAG"

    TMPDIR=$(mktemp -d)
    trap 'rm -rf "$TMPDIR"' EXIT

    TARBALL_URL="https://github.com/$REPO_OWNER/$REPO_NAME/releases/download/$LATEST_TAG/${REPO_NAME}-${LATEST_TAG}.tar.gz"
    echo "Downloading $TARBALL_URL..."

    if ! curl -fsSL "$TARBALL_URL" -o "$TMPDIR/release.tar.gz"; then
        fail "Failed to download release tarball"
    fi

    tar xzf "$TMPDIR/release.tar.gz" -C "$TMPDIR"

    # Find the extracted directory
    EXTRACTED=$(find "$TMPDIR" -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -1)
    if [[ -z "$EXTRACTED" ]]; then
        EXTRACTED="$TMPDIR"
    fi

    # Carry the configuration flags through to the extracted copy
    PASSTHRU=(--local)
    if [[ $WITH_DAEMON -eq 0 ]]; then
        # This script comes from main, but the one we're about to exec comes
        # from the latest release — which may predate the flag and would
        # silently do a full install instead, failing on sshfs for reasons
        # that would look unrelated.
        if ! grep -q -- '--no-daemon' "$EXTRACTED/install.sh"; then
            fail "$LATEST_TAG does not support --no-daemon yet. Install from a clone instead:
    git clone https://github.com/$REPO_OWNER/$REPO_NAME.git
    cd $REPO_NAME && ./install.sh --local --no-daemon"
        fi
        PASSTHRU+=(--no-daemon)
    fi

    exec bash "$EXTRACTED/install.sh" "${PASSTHRU[@]}"
fi

# --- --local mode: install from current directory ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$HOME/.local/share/open-agent"
BIN_DIR="$HOME/.local/bin"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_NAME="com.open-agent.daemon"
OA_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/open-agent"

echo ""
if [[ $WITH_DAEMON -eq 1 ]]; then
    echo "Installing open-agent from $SCRIPT_DIR"
else
    echo "Installing open-agent (client-only, no daemon) from $SCRIPT_DIR"
fi
echo ""

# --- Prerequisites ---

echo "Checking prerequisites..."

DENO=$(command -v deno 2>/dev/null || true)
[[ -n "$DENO" ]] || fail "deno not found. Install: https://deno.land/#installation"
info "deno: $DENO ($(deno --version | head -1))"

# sshfs and terminal-notifier are only ever invoked by the daemon — it does
# the mounting and the notifying. A client-only install talks to a daemon on
# another machine, so requiring them here would block installs that don't
# need them.
if [[ $WITH_DAEMON -eq 1 ]]; then
    if command -v sshfs &>/dev/null; then
        info "sshfs: $(command -v sshfs)"
    else
        fail "sshfs not found. Install macFUSE + sshfs:
    brew install --cask macfuse
    brew install gromgit/fuse/sshfs-mac

    Or, for a machine that only talks to a daemon elsewhere, install without
    the daemon (no sshfs needed):
    ./install.sh --local --no-daemon"
    fi

    if command -v terminal-notifier &>/dev/null; then
        info "terminal-notifier: $(command -v terminal-notifier)"
    else
        warn "terminal-notifier not found (optional, for notifications). Install: brew install terminal-notifier"
    fi
else
    info "Skipping sshfs and terminal-notifier checks (daemon-only dependencies)"
fi

# --- Install directories ---

echo ""
echo "Installing files..."

mkdir -p "$AGENT_DIR" "$BIN_DIR"
# Only the daemon mounts anything, so only it needs the mount root.
[[ $WITH_DAEMON -eq 1 ]] && mkdir -p "$HOME/.remote-mounts"

# --- Clean up old layout artifacts ---

# Prior versions installed files directly; the new layout uses src/
if [[ -f "$AGENT_DIR/open-agent-daemon.ts" ]]; then
    rm -f "$AGENT_DIR/open-agent-daemon.ts"
    info "Removed old $AGENT_DIR/open-agent-daemon.ts"
fi
if [[ -d "$BIN_DIR/lib" ]]; then
    rm -rf "${BIN_DIR:?}/lib"
    info "Removed old $BIN_DIR/lib/"
fi

# --- Copy source tree ---

# Remove stale source tree from previous install
rm -rf "$AGENT_DIR/src"
cp -R "$SCRIPT_DIR/src" "$AGENT_DIR/src"
info "src/ → $AGENT_DIR/src/"

# --- Install CLI wrappers (busybox-style: same file, multiple names) ---

# Commands that reach a daemon over the socket — useful wherever open-agent
# is installed. 'open-agent' itself stays for `update` / `version`.
CLIENT_CMDS="ropen rcopy rpaste rnotify rpush rpull rop rcode ra open-agent"
# Project launchers that drive the local daemon's mounts and tmux/VS Code —
# only meaningful on a machine that runs the daemon.
DAEMON_CMDS="rtmux rproj"

INSTALL_CMDS="$CLIENT_CMDS"
[[ $WITH_DAEMON -eq 1 ]] && INSTALL_CMDS="$CLIENT_CMDS $DAEMON_CMDS"

for cmd in $INSTALL_CMDS; do
    cp "$SCRIPT_DIR/oa-wrapper.sh" "$BIN_DIR/$cmd"
    chmod +x "$BIN_DIR/$cmd"
done
info "CLI wrappers → $BIN_DIR/ ($INSTALL_CMDS)"

# Switching a machine from a full install to --no-daemon leaves the host-only
# wrappers behind. There is no daemon here for them to drive any more, so they
# would fail at the socket; drop them rather than leave commands that cannot work.
if [[ $WITH_DAEMON -eq 0 ]]; then
    for cmd in $DAEMON_CMDS; do
        if [[ -e "$BIN_DIR/$cmd" ]]; then
            rm -f "$BIN_DIR/$cmd"
            info "Removed $cmd (drives the local daemon; not installed here)"
        fi
    done
fi

# --- Copy hook and wrapper template ---

cp "$SCRIPT_DIR/open-agent-hook.sh" "$AGENT_DIR/open-agent-hook.sh"
cp "$SCRIPT_DIR/oa-wrapper.sh" "$AGENT_DIR/oa-wrapper.sh"
info "open-agent-hook.sh, oa-wrapper.sh → $AGENT_DIR/"

# --- Install launchd plist ---

if [[ $WITH_DAEMON -eq 0 ]]; then
    echo ""
    echo "Skipping daemon (--no-daemon)."

    # A previous full install leaves a launchd job behind. Left alone it keeps
    # respawning against the source tree we just replaced, so say so rather
    # than leaving a daemon nobody asked for. Not removed automatically —
    # tearing down a service is the operator's call.
    if [[ -f "$LAUNCH_AGENTS/${PLIST_NAME}.plist" ]]; then
        warn "A daemon from a previous install is still registered with launchd."
        echo "    To remove it:"
        echo "      launchctl bootout gui/$(id -u)/${PLIST_NAME}"
        echo "      mv $LAUNCH_AGENTS/${PLIST_NAME}.plist $AGENT_DIR/${PLIST_NAME}.plist.disabled"
    fi
else

echo ""
echo "Setting up launchd..."

mkdir -p "$LAUNCH_AGENTS"

DENO_PATH=$(command -v deno)

# Generate plist with correct paths
sed \
    -e "s|/Users/YOURUSER/.deno/bin/deno|${DENO_PATH}|g" \
    -e "s|/Users/YOURUSER|${HOME}|g" \
    "$SCRIPT_DIR/com.open-agent.daemon.plist" \
    > "$LAUNCH_AGENTS/${PLIST_NAME}.plist"

info "Installed launchd plist to $LAUNCH_AGENTS/${PLIST_NAME}.plist"

# Unload if already running, then load
launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
sleep 1  # let launchd finish cleanup before re-bootstrapping

if ! launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/${PLIST_NAME}.plist" 2>/dev/null; then
    # Retry once — bootout/bootstrap race can cause transient "Input/output error"
    warn "First bootstrap attempt failed, retrying..."
    sleep 2
    launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
    sleep 1
    if ! launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/${PLIST_NAME}.plist"; then
        fail "Could not start agent via launchd. Try manually:
    launchctl bootstrap gui/$(id -u) $LAUNCH_AGENTS/${PLIST_NAME}.plist"
    fi
fi
info "Agent started via launchd"

# Verify it's running
sleep 2
if [[ -S "$AGENT_DIR/open-agent.sock" ]]; then
    info "Agent socket is live at $AGENT_DIR/open-agent.sock"
else
    warn "Agent socket not found yet. Check logs: cat $AGENT_DIR/launchd-stderr.log"
fi

fi  # end WITH_DAEMON

# --- Config migration ---

# remote-hosts drives rproj/rtmux and setup-remote, all of which run on the
# daemon host. A client has nothing to configure here.
if [[ $WITH_DAEMON -eq 1 ]]; then

echo ""
echo "Checking configuration..."

mkdir -p "$OA_CONFIG_DIR"

LEGACY_HOSTS="${XDG_CONFIG_HOME:-$HOME/.config}/rproj/hosts"
if [[ ! -f "$OA_CONFIG_DIR/remote-hosts" ]] && [[ -f "$LEGACY_HOSTS" ]]; then
    cp "$LEGACY_HOSTS" "$OA_CONFIG_DIR/remote-hosts"
    info "Migrated $LEGACY_HOSTS → $OA_CONFIG_DIR/remote-hosts"
elif [[ -f "$OA_CONFIG_DIR/remote-hosts" ]]; then
    info "Config already exists at $OA_CONFIG_DIR/remote-hosts"
else
    warn "No hosts config found. Create $OA_CONFIG_DIR/remote-hosts with format:"
    echo "    host_alias|project_dir|label"
    echo "    Example: workmbp|/Users/you/src/projects|Work"
fi

fi  # end WITH_DAEMON

# --- PATH check ---

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo ""
    warn "$BIN_DIR is not in your PATH. Add to your shell profile:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# --- Done ---

echo ""
echo "─────────────────────────────────────────────────"
echo "INSTALL COMPLETE"
echo "─────────────────────────────────────────────────"
echo ""

if [[ $WITH_DAEMON -eq 1 ]]; then
    echo "Add to your ~/.ssh/config (adjust Host name):"
    echo ""
    sed "s|/Users/YOURUSER|${HOME}|g" "$SCRIPT_DIR/ssh_config.example"
    echo ""
    echo "Next steps:"
    echo "  1. Configure hosts: $OA_CONFIG_DIR/remote-hosts"
    echo "  2. Deploy to remotes: open-agent setup-remote all"
    echo "  3. Reconnect SSH and test: ropen ~/some-file.md"
else
    echo "Installed the r* commands only — no daemon on this machine."
    echo "They reach the daemon on your personal Mac through the SSH tunnel,"
    echo "so that machine needs a RemoteForward for this host in its ~/.ssh/config."
    echo ""
    echo "Next steps:"
    echo "  1. Source the hook in ~/.zshrc (or ~/.bashrc):"
    echo "       source $AGENT_DIR/open-agent-hook.sh"
    echo "  2. Reconnect SSH to pick up the forwarded socket."
    echo "  3. Test: ra ping"
fi
echo ""
