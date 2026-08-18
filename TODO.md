# TODO

Follow-ons to the robustness rework (commits `29d2ed5`..`e8b5216`). All
optional — the daemon and `ra` tooling work without these.

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
