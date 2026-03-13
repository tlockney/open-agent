#!/bin/bash
# install.sh — sets up open-agent on the LOCAL (personal) machine.
# Remote setup is a separate manual step (see instructions at end).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$HOME/.local/share/open-agent"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_NAME="com.open-agent.daemon"
DENO=$(command -v deno 2>/dev/null || true)

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# --- Prerequisites ---

echo "Checking prerequisites..."

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
    echo "  The remote wrapper will fall back to nc, but socat is more reliable."
fi

# --- Install agent ---

echo ""
echo "Installing agent..."

mkdir -p "$AGENT_DIR"
mkdir -p "$HOME/.remote-mounts"

cp "$SCRIPT_DIR/agent.ts" "$AGENT_DIR/agent.ts"
info "Copied agent.ts to $AGENT_DIR/"

# --- Install launchd plist ---

echo ""
echo "Setting up launchd..."

mkdir -p "$LAUNCH_AGENTS"

DENO_PATH=$(command -v deno)
USER=$(whoami)

# Generate plist with correct paths
sed \
    -e "s|/Users/YOURUSER/.deno/bin/deno|${DENO_PATH}|g" \
    -e "s|/Users/YOURUSER|${HOME}|g" \
    "$SCRIPT_DIR/config/com.open-agent.daemon.plist" \
    > "$LAUNCH_AGENTS/${PLIST_NAME}.plist"

info "Installed launchd plist to $LAUNCH_AGENTS/${PLIST_NAME}.plist"

# Unload if already running, then load
launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/${PLIST_NAME}.plist"
info "Agent started via launchd"

# Verify it's running
sleep 1
if [[ -S "$AGENT_DIR/open-agent.sock" ]]; then
    info "Agent socket is live at $AGENT_DIR/open-agent.sock"
else
    warn "Agent socket not found yet. Check logs: cat $AGENT_DIR/launchd-stderr.log"
fi

# --- SSH config reminder ---

echo ""
echo "─────────────────────────────────────────────────"
echo "LOCAL SETUP COMPLETE"
echo "─────────────────────────────────────────────────"
echo ""
echo "Add to your ~/.ssh/config (adjust Host name):"
echo ""
sed "s|/Users/YOURUSER|${HOME}|g" "$SCRIPT_DIR/config/ssh_config.example"
echo ""
echo "─────────────────────────────────────────────────"
echo "REMOTE SETUP (on work machine)"
echo "─────────────────────────────────────────────────"
echo ""
echo "1. Copy remote scripts:"
echo "   scp $SCRIPT_DIR/remote/ropen work:~/bin/ropen"
echo "   scp $SCRIPT_DIR/remote/open-agent-hook.sh work:~/.config/open-agent-hook.sh"
echo "   ssh work 'chmod +x ~/bin/ropen'"
echo ""
echo "2. Add to ~/.zshrc on the remote machine:"
echo '   export OPEN_AGENT_HOST="work"  # must match your SSH Host alias'
echo '   source ~/.config/open-agent-hook.sh'
echo ""
echo "3. Install socat on the remote (recommended):"
echo "   brew install socat"
echo ""
echo "4. Reconnect SSH. Test:"
echo "   ropen ~/some-file.md"
echo "   ropen -a 'Marked 2' ~/notes.md"
echo "   ropen -v ~/projects/myapp"
echo ""
