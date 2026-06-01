# SSH-aware local fallback for `r*` commands

## Problem

The `r*` commands (`ropen`, `rcopy`, `rpaste`, `rop`, `rcode`, ...) exist to
bridge a remote SSH session back to the local Mac via the open-agent daemon.
Because the same shell config (dotfiles) is installed on every machine, these
commands are also on `PATH` when sitting directly at the local Mac — where the
daemon round-trip is pointless. Today, running e.g. `ropen README.md` locally
either errors with "agent unreachable" or produces nonsense, when the user
almost certainly just meant `open README.md`.

`rcode.ts` already solves this for itself: it branches on `SSH_CONNECTION` and
delegates to a local command when not in an SSH session. This design
generalizes that pattern to the other commands that have a meaningful local
equivalent.

## Goal

When a command runs **outside** an SSH session, transparently exec the native
local tool instead of contacting the daemon. When inside an SSH session,
behavior is unchanged.

## Detection

A single shared helper in `src/lib/oa.ts`:

```ts
/**
 * True when running inside an SSH session — i.e. on the remote machine,
 * where the r* commands should reach back to the local agent. False means
 * we're sitting at the local Mac and should run the native equivalent.
 */
export function isRemoteSession(): boolean {
  return Boolean(
    Deno.env.get("SSH_CONNECTION") ||
    Deno.env.get("SSH_TTY") ||
    Deno.env.get("SSH_CLIENT"),
  );
}
```

The broader three-variable check (rather than `SSH_CONNECTION` alone) is more
robust to environments where one variable is stripped. It remains pure
env-var logic with no I/O, so detection stays instant.

## Per-command local fallback

Each command calls `isRemoteSession()` early. When it returns `false`, the
command execs the native local equivalent and exits with that process's exit
code. The fallback is **silent** — no extra output — matching `rcode`'s
existing behavior and keeping stdout clean for pipes.

| Command  | Local fallback |
|----------|----------------|
| `ropen`  | URL → `open <url>`; `-v` → `code <path>`; `-a <app>` → `open -a <app> <path>`; otherwise → `open <path>`. The branch is placed *after* the existing path-resolution block and *before* the daemon `Message` is built, so the resolved absolute path is reused. |
| `rcopy`  | Pipe the stdin already read into `pbcopy`. |
| `rpaste` | Run `pbpaste`, writing its stdout to this process's stdout. |
| `rop`    | Delegate verbatim: exec `op` with `Deno.args`. `op` performs its own `op://` resolution and `--account` passes straight through. The no-arg / `-h` usage screen is unchanged. |

`ropen -v` locally assumes `code` is on the local `PATH` (accepted).

## Retrofit `rcode`

Replace `rcode.ts`'s inline `Deno.env.get("SSH_CONNECTION")` check with
`isRemoteSession()` (one import, one condition changed) so there is a single
detection rule across all commands. The shell hook (`open-agent-hook.sh`) is
left unchanged.

## Interaction with `ropen`'s existing no-fallback guard

`ropen` deliberately refuses to fall back to native `open` when the agent is
**unreachable**, because a remote-mount path opened on the local filesystem is
garbage. This design does not weaken that:

- Agent unreachable **while remote** (`isRemoteSession()` true): the existing
  guard still fires and errors loudly.
- **Not remote** (`isRemoteSession()` false): the path is already a real local
  path, so native `open` is exactly correct.

The two checks compose cleanly because they answer different questions
("can I reach the agent?" vs. "am I remote at all?").

## Permissions

`oa-wrapper.sh` runs every command with a fixed permission set that already
includes `--allow-run`, so `open` / `code` / `pbcopy` / `pbpaste` / `op` all
exec in the production install path regardless of per-file shebangs. No
permission widening is required. (Per-file shebangs for `rcopy`/`rpaste` lack
`--allow-run` and only affect direct `./rcopy.ts` execution; updating them for
parity is optional and not part of this work.)

## Testing

- `isRemoteSession()` — unit tests in `oa_test.ts`: each variable set alone,
  none set, several set at once.
- The per-command exec branches are thin, side-effecting glue (spawning
  `open`/`pbcopy`/`pbpaste`/`op`). They are kept minimal and not unit-tested,
  consistent with how `rcode`'s branches are handled today.

## Out of scope

- `rpush` / `rpull` — file moves between machines have no clean local meaning.
- `rnotify` — not requested for this change.
- A `OPEN_AGENT_FORCE_REMOTE` escape hatch for environments that strip all SSH
  variables (e.g. some tmux setups) — not needed; the broader env check
  mitigates the common cases.
- Widening per-file shebang permissions (production uses the wrapper's perms).
