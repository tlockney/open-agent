// mount_manager.ts — SSHFS mount lifecycle management with dependency injection.

/** System dependencies injected for testability. */
export interface MountDeps {
  runCommand(
    cmd: string,
    args: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ success: boolean; stdout: Uint8Array; stderr: Uint8Array }>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Read the persisted mount table; rejects when it does not exist. */
  readTextFile(path: string): Promise<string>;
  /** Replace the persisted mount table. */
  writeTextFile(path: string, data: string): Promise<void>;
  log(msg: string): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** Current on-disk format of the mount table. */
const STATE_VERSION = 1;

interface PersistedMount {
  host: string;
  remoteHome: string;
  mountPoint: string;
}

interface PersistedState {
  version: number;
  mounts: PersistedMount[];
}

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== STATE_VERSION || !Array.isArray(obj.mounts)) return false;
  return obj.mounts.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const m = entry as Record<string, unknown>;
    return typeof m.host === "string" &&
      typeof m.remoteHome === "string" &&
      typeof m.mountPoint === "string";
  });
}

/** Internal mount state tracking. */
export interface MountState {
  host: string;
  remoteHome: string;
  mountPoint: string;
  sessions: Set<string>;
  unmountTimer?: number;
}

const decoder = new TextDecoder();

/**
 * Mount points currently in the system mount table.
 *
 * `mount(8)` prints one entry per line as `<device> on <path> (<options>)`.
 * The previous check was a substring search for the mount point anywhere in
 * that output, so host `work` matched the line belonging to `work2` and the
 * daemon believed a mount was live when it was not. Parsing the path out and
 * comparing whole values removes the prefix collision — and reconciling
 * persisted state against this list depends on it being exact.
 *
 * The options group is anchored to end-of-line so a mount point containing
 * spaces, or even parentheses, still parses.
 */
export function parseMountPoints(mountOutput: string): string[] {
  const points: string[] = [];
  for (const line of mountOutput.split("\n")) {
    const match = line.match(/ on (.+) \([^()]*\)$/);
    if (match) points.push(match[1]);
  }
  return points;
}

export class MountManager {
  private mounts = new Map<string, MountState>();
  private mountLocks = new Map<string, Promise<MountState>>();

  constructor(
    private deps: MountDeps,
    private mountBase: string,
    private unmountGraceMs: number,
    /** Where the mount table is mirrored so it survives a daemon restart. */
    private statePath: string,
  ) {}

  /**
   * Rebuild the in-memory table from disk, keeping only entries whose mount
   * point is still in the system mount table.
   *
   * Without this a restart lost the table while the SSHFS mounts themselves
   * survived, so the next request mounted a second time over the same mount
   * point and `ra mounts` reported nothing.
   *
   * Sessions are deliberately not restored: the shells that owned those ids
   * did not survive the restart either. A recovered mount therefore has no
   * sessions and nothing schedules its unmount, so it persists until a
   * session connects and disconnects normally, or `ra reset` clears it. That
   * is the conservative side to err on — tearing down a mount that a live
   * session is still using would be worse than leaving one to be reclaimed.
   */
  async restore(): Promise<void> {
    let raw: string;
    try {
      raw = await this.deps.readTextFile(this.statePath);
    } catch {
      return; // No state file: a first run, or a clean shutdown removed it.
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.deps.log(`Ignoring unreadable mount state at ${this.statePath}`);
      return;
    }

    if (!isPersistedState(parsed)) {
      this.deps.log(`Ignoring mount state in an unrecognised format`);
      return;
    }

    const live = await this.mountedPoints();
    const recovered: string[] = [];
    const dropped: string[] = [];

    for (const entry of parsed.mounts) {
      if (live.includes(entry.mountPoint)) {
        this.mounts.set(entry.host, {
          host: entry.host,
          remoteHome: entry.remoteHome,
          mountPoint: entry.mountPoint,
          sessions: new Set(),
        });
        recovered.push(entry.host);
      } else {
        dropped.push(entry.host);
      }
    }

    if (recovered.length > 0) {
      this.deps.log(
        `Recovered ${recovered.length} mount(s): ${recovered.join(", ")}`,
      );
    }
    if (dropped.length > 0) {
      this.deps.log(
        `Dropped ${dropped.length} stale mount record(s): ${
          dropped.join(", ")
        }`,
      );
    }
    await this.persist();
  }

  /**
   * Mirror the table to disk. Never allowed to fail an operation: losing the
   * file costs a restart's worth of recovery, whereas failing the mount that
   * triggered the write costs the user their command.
   */
  private async persist(): Promise<void> {
    const state: PersistedState = {
      version: STATE_VERSION,
      mounts: [...this.mounts.values()].map((
        { host, remoteHome, mountPoint },
      ) => ({ host, remoteHome, mountPoint })),
    };
    try {
      await this.deps.writeTextFile(
        this.statePath,
        JSON.stringify(state, null, 2) + "\n",
      );
    } catch (e) {
      this.deps.log(`Could not persist mount state: ${e}`);
    }
  }

  /** Get the current mount state for a host (if any). */
  getMount(host: string): MountState | undefined {
    return this.mounts.get(host);
  }

  /** Get all current mounts. */
  getAllMounts(): ReadonlyMap<string, MountState> {
    return this.mounts;
  }

  /**
   * Ensure a mount exists for the given host, creating one if needed.
   * Concurrent calls for the same host are serialized to prevent parallel sshfs spawns.
   */
  ensureMount(host: string, remoteHome: string): Promise<MountState> {
    const existing = this.mountLocks.get(host) ??
      Promise.resolve(undefined as unknown as MountState);
    const next = existing
      .catch(() => undefined as unknown as MountState)
      .then(() => this.doMount(host, remoteHome));
    const guarded = next.catch((e: unknown) => {
      throw e;
    });
    this.mountLocks.set(host, guarded);
    guarded.catch(
      () => {/* prevent unhandled rejection on the stored promise */},
    )
      .finally(() => {
        if (this.mountLocks.get(host) === guarded) this.mountLocks.delete(host);
      });
    return next;
  }

  /** Schedule unmount after grace period if no sessions remain. */
  scheduleUnmount(host: string): void {
    const state = this.mounts.get(host);
    if (!state) return;

    if (state.unmountTimer !== undefined) {
      this.deps.clearTimeout(state.unmountTimer);
    }

    this.deps.log(
      `Scheduling unmount for ${host} in ${this.unmountGraceMs / 1000}s`,
    );
    state.unmountTimer = this.deps.setTimeout(() => {
      if (state.sessions.size === 0) {
        this.unmountHost(host);
      }
    }, this.unmountGraceMs);
  }

  /** Unmount a specific host and remove its state. */
  async unmountHost(host: string): Promise<void> {
    const state = this.mounts.get(host);
    if (!state) return;

    this.deps.log(`Unmounting ${host} (${state.mountPoint})`);
    await this.forceUnmount(state.mountPoint);
    this.mounts.delete(host);
    await this.persist();
  }

  /** Unmount all hosts (used during shutdown). */
  async unmountAll(): Promise<void> {
    for (const host of [...this.mounts.keys()]) {
      await this.unmountHost(host);
    }
  }

  /** Check whether a mount point appears in the system mount table. */
  async isMounted(mountPoint: string): Promise<boolean> {
    return (await this.mountedPoints()).includes(mountPoint);
  }

  /** Every mount point the system currently reports, or [] if unreadable. */
  private async mountedPoints(): Promise<string[]> {
    try {
      const result = await this.deps.runCommand("mount", []);
      return parseMountPoints(decoder.decode(result.stdout));
    } catch {
      return [];
    }
  }

  /** Check whether a mount point is both present and responsive. */
  async isMountResponsive(mountPoint: string): Promise<boolean> {
    if (!await this.isMounted(mountPoint)) return false;
    try {
      const result = await this.deps.runCommand("stat", [mountPoint], {
        signal: AbortSignal.timeout(3000),
      });
      return result.success;
    } catch {
      return false;
    }
  }

  // --- Private ---

  private async doMount(host: string, remoteHome: string): Promise<MountState> {
    let state = this.mounts.get(host);

    if (state) {
      // Cancel any pending unmount
      if (state.unmountTimer !== undefined) {
        this.deps.clearTimeout(state.unmountTimer);
        state.unmountTimer = undefined;
      }

      // Update remoteHome if it changed (shouldn't, but defensive)
      state.remoteHome = remoteHome;

      // Verify mount is alive
      if (await this.isMountResponsive(state.mountPoint)) {
        return state;
      }

      // Mount died — clean up and remount
      this.deps.log(`Mount for ${host} is stale, remounting...`);
      await this.forceUnmount(state.mountPoint);
    }

    const mountPoint = `${this.mountBase}/${host}`;
    await this.deps.mkdir(mountPoint, { recursive: true });

    this.deps.log(`Mounting ${host}:${remoteHome} at ${mountPoint}`);
    const result = await this.deps.runCommand("sshfs", [
      `${host}:${remoteHome}`,
      mountPoint,
      "-o",
      "reconnect",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "follow_symlinks",
      "-o",
      `volname=remote-${host}`,
      "-o",
      "cache=yes",
      "-o",
      "cache_timeout=120",
      "-o",
      "attr_timeout=120",
    ]);

    if (!result.success) {
      const err = decoder.decode(result.stderr);
      throw new Error(`sshfs mount failed: ${err}`);
    }

    state = {
      host,
      remoteHome,
      mountPoint,
      sessions: state?.sessions ?? new Set(),
    };
    this.mounts.set(host, state);
    await this.persist();
    this.deps.log(`Mounted ${host} successfully`);
    return state;
  }

  private async forceUnmount(mountPoint: string): Promise<void> {
    try {
      const result = await this.deps.runCommand("umount", [mountPoint]);
      if (result.success) return;
    } catch { /* fall through */ }

    try {
      await this.deps.runCommand("diskutil", ["unmount", "force", mountPoint]);
    } catch (e) {
      this.deps.log(`Force unmount failed for ${mountPoint}: ${e}`);
    }
  }
}

/** Create MountDeps backed by real Deno APIs. */
export function createRealDeps(log: (msg: string) => void): MountDeps {
  return {
    async runCommand(cmd, args, opts) {
      const command = new Deno.Command(cmd, {
        args,
        signal: opts?.signal,
      });
      const result = await command.output();
      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    async mkdir(path, opts) {
      await Deno.mkdir(path, opts);
    },
    readTextFile: (path) => Deno.readTextFile(path),
    writeTextFile: (path, data) => Deno.writeTextFile(path, data),
    log,
    // Coerce to `number`: newer Deno types the global setTimeout as returning
    // `Timeout`, but MountDeps (and the tests) use numeric timer ids. The id is
    // a number at runtime on Deno, so Number() is a safe, version-stable pin.
    setTimeout: (fn, ms) => Number(setTimeout(fn, ms)),
    clearTimeout: (id) => clearTimeout(id),
  };
}
