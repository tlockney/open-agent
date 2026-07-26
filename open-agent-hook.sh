# shellcheck shell=bash
# open-agent-hook.sh
# Source this from .zshrc (or .bashrc) on the REMOTE machine.
# Registers/unregisters SSH sessions with the local open-agent daemon
# so it can manage SSHFS mount lifecycle.

# Only activate for SSH sessions
[[ -z "$SSH_CONNECTION" ]] && return 0

_OA_SOCK="${OPEN_AGENT_SOCK:-/tmp/open-agent.sock}"
# Resolve host identity: env var → identity file → unresolved.
# Must be unique per remote and match the SSH Host alias on the local machine.
#
# There is deliberately no `hostname -s` fallback. The daemon hands this
# value straight to sshfs as an SSH destination, and a remote's own hostname
# usually is not the alias the local Mac knows it by — so guessing mounts the
# wrong host or fails obscurely. src/lib/oa.ts resolves identity the same way;
# the two must agree or the hook and the r* commands register different keys.
if [[ -n "${OPEN_AGENT_HOST:-}" ]]; then
    _OA_HOST="$OPEN_AGENT_HOST"
elif [[ -r "$HOME/.config/open-agent/identity" ]]; then
    _OA_HOST="$(tr -d '[:space:]' < "$HOME/.config/open-agent/identity" 2>/dev/null)"
else
    _OA_HOST=""
fi
_OA_SID="$$-$(date +%s)"

_oa_send() {
    if [[ -S "$_OA_SOCK" ]]; then
        if command -v socat &>/dev/null; then
            echo "$1" | socat -t3 - UNIX-CONNECT:"$_OA_SOCK" 2>/dev/null
        elif command -v nc &>/dev/null; then
            echo "$1" | nc -U -w3 "$_OA_SOCK" 2>/dev/null
        fi
    fi
}

_oa_json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "$s"
}

# Register this session
if [[ -S "$_OA_SOCK" ]]; then
    # Only complain when the agent is actually reachable — this file gets
    # sourced on hosts with no forwarded socket, and warning there would be
    # noise on every shell.
    if [[ -z "$_OA_HOST" ]]; then
        echo "open-agent: cannot determine this machine's identity — set OPEN_AGENT_HOST," >&2
        echo "  or write the name to ~/.config/open-agent/identity. It must match the SSH" >&2
        echo "  Host alias the local Mac uses for this machine. Session not registered." >&2
        return 0
    fi

    _OA_HOST_ESC=$(_oa_json_escape "$_OA_HOST")
    _OA_HOME_ESC=$(_oa_json_escape "$HOME")
    _OA_SID_ESC=$(_oa_json_escape "$_OA_SID")
    _oa_send "{\"action\":\"connect\",\"host\":${_OA_HOST_ESC},\"remoteHome\":${_OA_HOME_ESC},\"sessionId\":${_OA_SID_ESC}}" >/dev/null 2>&1

    # Unregister on shell exit
    _oa_cleanup() {
        _oa_send "{\"action\":\"disconnect\",\"host\":${_OA_HOST_ESC},\"sessionId\":${_OA_SID_ESC}}" >/dev/null 2>&1
    }
    trap _oa_cleanup EXIT HUP TERM

    # Alias open -> ropen if available
    if command -v ropen &>/dev/null; then
        alias open='ropen'
    fi

    # Status helper
    oa-status() {
        _oa_send '{"action":"status"}'
    }
fi
