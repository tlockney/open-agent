// version.ts — the single source of truth for the release version.
//
// The daemon and the open-agent CLI both report a version, and they were
// separate constants that had to be bumped together. Nothing caught a miss,
// so `ra ping` could report one version while `open-agent version` reported
// another.

export const VERSION = "0.8.1";
