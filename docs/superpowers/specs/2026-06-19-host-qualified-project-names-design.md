# Host-qualified project names

## Problem

When the same project name exists on more than one configured remote
host (e.g. a `personal` directory on both `m4mini` and `janus`),
`rproj`/`rtmux`/`rcode` can't be told *which* host to use without the
`-h/--host` flag. The flag works but is verbose. We want a compact
inline form that names the host and project together:

```
rtmux m4mini:personal
rcode m4mini:personal
rproj tmux m4mini:personal
```

This disambiguates duplicate project names across hosts in a single
token, mirroring the familiar `scp`/`ssh` `host:path` convention.

## Surface

The `host:project` form is accepted anywhere a project name is accepted
on the **local** side:

- `rtmux m4mini:personal` (wrapper forwards to `rproj tmux`)
- `rcode m4mini:personal` (local branch forwards to `rproj code`)
- `rproj tmux m4mini:personal`, `rproj code m4mini:personal`,
  `rproj c`/`t` short aliases
- bare `rproj m4mini:personal` (default interactive action, host pinned)
- `-p m4mini:personal` (the explicit project-name flag)

Trailing-colon form `m4mini:` pins the host and leaves the project
unspecified, falling through to the existing interactive picker scoped
to that host.

### Out of scope

The **remote**-session branch of `rcode` (when you are already inside an
SSH session on one host and `rcode` sends an `open-vscode` action through
the agent socket via `ropen`) is unaffected. `host:project` is a
local-side, cross-host concept; inside a remote session you are already
pinned to one host. This is documented in the README rather than wired.

## Parsing semantics

Decided during brainstorming:

- **Strict split on the first colon.** Text before the first `:` is
  always the host; the remainder is the project name. There is no
  alias-validation fallback — `bogus:personal` is parsed as
  host `bogus`, project `personal`, and fails later with a clear
  "host not found" error rather than being searched literally.
- A project name containing no colon behaves exactly as today.
- **Conflict with `-h/--host` is an error.** If both a `-h` flag and a
  `host:` prefix specify a host and they disagree, error out. If they
  agree, allow it.

Edge cases:

| Input | Result |
|---|---|
| `m4mini:personal` | host `m4mini`, project `personal` |
| `personal` | host `null`, project `personal` (unchanged behavior) |
| `m4mini:` | host `m4mini`, project `null` → interactive, host-scoped |
| `:personal` | error: empty host |
| `m4mini:sub:dir` | host `m4mini`, project `sub:dir` (split on first `:` only) |
| `-h janus m4mini:personal` | error: host given twice |
| `-h m4mini m4mini:personal` | OK, host `m4mini`, project `personal` |
| `bogus:personal` (bogus unconfigured) | error: no entries for host `bogus` |

## Design

All three commands funnel through one chokepoint: `rproj`'s
`getProjectSelection(hosts, opts)`, which already takes a `hostFilter`
and a `projectName`. `rtmux` and the local branch of `rcode` are thin
wrappers that forward their args verbatim to `rproj`. So `host:project`
is syntactic sugar for the existing `--host HOST` + project-name pair —
wiring it into `rproj`'s argument parser lights up all three commands
with no changes to the wrappers.

### 1. Pure helper in `src/lib/rproj_utils.ts`

```ts
/**
 * Split a possibly host-qualified project token into its host and name.
 * Strict: splits on the FIRST colon only. No colon → host is null.
 * Throws on an empty host (leading colon).
 */
export function splitHostQualifier(
  raw: string,
): { host: string | null; name: string }
```

Behavior:

- No `:` → `{ host: null, name: raw }`
- `host:name` → `{ host, name }` (name may be `""`)
- Leading `:` (empty host) → throws an `Error`
- Splits on the first colon only; later colons stay in `name`

This is the only new unit-tested logic.

### 2. Reconcile in `rproj.ts` `parseArgs`

After deriving `projectName` (from `-p` or the positional) and
`hostFilter` (from `-h`):

1. If `projectName` is non-null, run `splitHostQualifier(projectName)`.
   A thrown error (empty host) is reported via `error()`.
2. If the split yields a `host`:
   - `hostFilter` unset → set `hostFilter` to the prefix host.
   - `hostFilter` set and equal → keep it.
   - `hostFilter` set and different → `error()` with
     `host given twice (-h <flag> vs <prefix>:)`.
3. Set `projectName` to the split `name`, or `null` if `name` is empty
   (trailing colon → interactive, host-scoped).

The unknown-host case needs no new code: `loadHosts(hostFilter)`
already errors with `No entries found for host: <h>` when the filter
matches no configured entries.

### 3. Help text and README

- Extend `rproj.ts` `showHelp()` examples with the `host:project` form.
- Document the feature in `README.md`, including the out-of-scope note
  for the remote `rcode` branch.

## Testing

- Unit tests for `splitHostQualifier` in
  `src/lib/rproj_utils_test.ts`: no colon, normal `host:name`, trailing
  colon (empty name), leading colon (throws), multiple colons (split on
  first only), empty string.
- The reconcile/conflict logic lives in `parseArgs`, which calls
  `error()` (process exit) and is not currently unit-tested. The pure
  `splitHostQualifier` carries the testable logic; the conflict path is
  verified manually. (If we later extract `parseArgs` reconciliation
  into a pure function, it can be tested then — not in scope here.)

## Files touched

- `src/lib/rproj_utils.ts` — add `splitHostQualifier`
- `src/lib/rproj_utils_test.ts` — tests for it
- `src/cli/rproj.ts` — wire into `parseArgs`, extend `showHelp()`
- `README.md` — document the syntax and the remote-`rcode` caveat

No changes to `rtmux.ts` or `rcode.ts` — they forward verbatim.
