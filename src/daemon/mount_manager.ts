// mount_manager.ts — SSHFS mount lifecycle management with dependency injection.

/** System dependencies injected for testability. */
export interface MountDeps {
  runCommand(
    cmd: string,
    args: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ success: boolean; stdout: Uint8Array; stderr: Uint8Array }>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  log(msg: string): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
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

export class MountManager {
  private mounts = new Map<string, MountState>();
  private mountLocks = new Map<string, Promise<MountState>>();

  constructor(
    private deps: MountDeps,
    private mountBase: string,
    private unmountGraceMs: number,
  ) {}

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
    const existing = this.mountLocks.get(host) ?? Promise.resolve(undefined as unknown as MountState);
    const next = existing
      .catch(() => undefined as unknown as MountState)
      .then(() => this.doMount(host, remoteHome));
    const guarded = next.catch((e: unknown) => { throw e; });
    this.mountLocks.set(host, guarded);
    guarded.catch(() => { /* prevent unhandled rejection on the stored promise */ })
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

    this.deps.log(`Scheduling unmount for ${host} in ${this.unmountGraceMs / 1000}s`);
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
  }

  /** Unmount all hosts (used during shutdown). */
  async unmountAll(): Promise<void> {
    for (const host of [...this.mounts.keys()]) {
      await this.unmountHost(host);
    }
  }

  /** Check whether a mount point appears in the system mount table. */
  async isMounted(mountPoint: string): Promise<boolean> {
    try {
      const result = await this.deps.runCommand("mount", []);
      const output = decoder.decode(result.stdout);
      return output.includes(mountPoint);
    } catch {
      return false;
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
      "-o", "reconnect",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "follow_symlinks",
      "-o", `volname=remote-${host}`,
      "-o", "cache=yes",
      "-o", "cache_timeout=120",
      "-o", "attr_timeout=120",
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
      return { success: result.success, stdout: result.stdout, stderr: result.stderr };
    },
    async mkdir(path, opts) {
      await Deno.mkdir(path, opts);
    },
    log,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}
