#!/bin/bash
# install.sh — install open-agent on the local (personal) Mac
#
# Two modes:
#   curl -fsSL <url> | bash    — downloads latest release, then runs --local
#   ./install.sh --local       — installs from the current directory

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

# --- curl | sh mode (default) ---

if [[ "${1:-}" != "--local" ]]; then
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

    exec bash "$EXTRACTED/install.sh" --local
fi

# --- --local mode: install from current directory ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$HOME/.local/share/open-agent"
BIN_DIR="$HOME/.local/bin"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_NAME="com.open-agent.daemon"
OA_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/open-agent"

echo ""
echo "Installing open-agent from $SCRIPT_DIR"
echo ""

# --- Prerequisites ---

echo "Checking prerequisites..."

DENO=$(command -v deno 2>/dev/null || true)
[[ -n "$DENO" ]] || fail "deno not found. Install: https://deno.land/#installation"
info "deno: $DENO ($(deno --version | head -1))"

if command -v sshfs &>/dev/null; then
    info "sshfs: $(command -v sshfs)"
else
    fail "sshfs not found. Install macFUSE + sshfs:
    brew install --cask macfuse
    brew install gromgit/fuse/sshfs-mac"
fi

if command -v socat &>/dev/null; then
    info "socat: $(command -v socat)"
else
    warn "socat not found (optional but recommended). Install: brew install socat"
fi

if command -v terminal-notifier &>/dev/null; then
    info "terminal-notifier: $(command -v terminal-notifier)"
else
    warn "terminal-notifier not found (optional, for notifications). Install: brew install terminal-notifier"
fi

# --- Install directories ---

echo ""
echo "Installing files..."

mkdir -p "$AGENT_DIR" "$BIN_DIR/lib" "$HOME/.remote-mounts"

# --- Copy agent ---

cp "$SCRIPT_DIR/agent.ts" "$AGENT_DIR/agent.ts"
info "agent.ts → $AGENT_DIR/"

# --- Copy bin scripts ---

for script in "$SCRIPT_DIR"/bin/*; do
    [[ -d "$script" ]] && continue  # skip lib/ directory
    cp "$script" "$BIN_DIR/"
    chmod +x "$BIN_DIR/$(basename "$script")"
done
info "bin scripts → $BIN_DIR/"

# --- Copy lib ---

cp "$SCRIPT_DIR/bin/lib/open-agent.sh" "$BIN_DIR/lib/open-agent.sh"
info "lib/open-agent.sh → $BIN_DIR/lib/"

# --- Copy hook ---

cp "$SCRIPT_DIR/open-agent-hook.sh" "$AGENT_DIR/open-agent-hook.sh"
info "open-agent-hook.sh → $AGENT_DIR/"

# --- Install launchd plist ---

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

# --- Config migration ---

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
echo "Add to your ~/.ssh/config (adjust Host name):"
echo ""
sed "s|/Users/YOURUSER|${HOME}|g" "$SCRIPT_DIR/ssh_config.example"
echo ""
echo "Next steps:"
echo "  1. Configure hosts: $OA_CONFIG_DIR/remote-hosts"
echo "  2. Deploy to remotes: open-agent setup-remote all"
echo "  3. Reconnect SSH and test: ropen ~/some-file.md"
echo ""
