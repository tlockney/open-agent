# TODO

Follow-ons to the robustness rework (commits `29d2ed5`..`e8b5216`). All
optional — the daemon and `ra` tooling work without these.

## `ra logs [-f]`

Tail the launchd-managed daemon log so users don't have to remember the
path.

- launchd writes stdout to `$AGENT_DIR/launchd-stdout.log` and stderr to
  `$AGENT_DIR/launchd-stderr.log` (see `com.open-agent.daemon.plist`).
- CLI shape: `ra logs` prints last N lines, `ra logs -f` streams.
- Implementation can shell out to `tail`; no new daemon action needed.

## Optional opt-in background heartbeat

The current self-healing is request-driven (covered by step 3 of the
rework): a real `open` request that lands on a stale mount triggers
the remount. That's bounded and predictable, but means the *first*
request after an SSH flap eats the recovery latency.

- Add an opt-in heartbeat that periodically calls
  `mountManager.isMountResponsive` for each mount, and force-remounts
  on failure.
- Off by default. Enable via env var or a config file flag — never
  silently background.
- Reason for the gating: background heartbeats can mask real problems
  and create spurious filesystem activity. Worth having for users who
  prioritize warm mounts; not a default for everyone.
