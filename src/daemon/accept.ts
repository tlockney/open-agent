// accept.ts — the daemon's accept loop.
//
// Split out from main.ts so the retry/teardown policy can be tested without
// binding real sockets.

/** The slice of Deno.Listener the accept loop needs. */
export interface AcceptListener<T> {
  accept(): Promise<T>;
}

/**
 * How long a run of accept errors must persist before the loop starts pausing
 * between retries.
 *
 * A single accept() can fail without the listener being dead. macOS returns
 * EINVAL (os error 22) when a client closes between connect() and accept(),
 * which any short-lived r* command does routinely. A burst of those is over
 * in milliseconds, so it stays inside this window and is retried at full
 * speed — pausing during a burst would stall the listener for exactly as long
 * as the clients are hammering it.
 *
 * Sustained failure is the other case, and the one worth defending against: a
 * genuinely broken listener rejects instantly and forever, spinning at
 * whatever rate the CPU allows.
 */
export const BACKOFF_AFTER_MS = 100;

/**
 * Pause between retries once a run has outlived BACKOFF_AFTER_MS, capping a
 * hot spin at roughly twenty attempts per second instead of thousands.
 */
export const BACKOFF_MS = 50;

/**
 * Give up on a listener that has failed *continuously* for this long.
 *
 * Deliberately a duration and not a count. The previous policy abandoned the
 * listener after 20 consecutive errors, which a burst of aborted client
 * connections reaches trivially — 25 rapid connect-then-close cycles did it —
 * and when the TCP listener had failed to bind (the normal case on a machine
 * that is also an open-agent remote) the Unix listener was the only one, so
 * abandoning it exited the daemon and lost every session's mount state.
 *
 * A burst is bounded in time: those 25 aborts complete in milliseconds. A
 * broken listener is not, so only continuous failure trips this. Abandoning
 * then is still the right move — main() exits non-zero and launchd restarts
 * with a fresh listener, which is the only way to recover a dead descriptor.
 */
export const ABANDON_AFTER_MS = 30_000;

/** Options for the accept loop; the defaults are the production policy. */
export interface AcceptOptions {
  /** Wall clock, injectable so tests need not actually wait. */
  now?: () => number;
  /** Delay between retries, injectable for the same reason. */
  sleep?: (ms: number) => Promise<void>;
  /** Continuous-failure budget before giving up on the listener. */
  abandonAfterMs?: number;
  /** How long a failing run must last before retries start pausing. */
  backoffAfterMs?: number;
  /** Pause applied to retries once past `backoffAfterMs`. */
  backoffMs?: number;
}

/** True when the error means the listener itself is gone, not the connection. */
function isListenerClosed(e: unknown): boolean {
  return e instanceof Deno.errors.BadResource ||
    e instanceof Deno.errors.Interrupted;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/**
 * Accept connections until the listener closes or fails continuously for too
 * long, handing each one to `handle`. Resolves when the loop stops; never
 * rejects.
 */
export async function acceptConnections<T>(
  listener: AcceptListener<T>,
  handle: (conn: T) => Promise<void>,
  log: (msg: string) => void,
  options: AcceptOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const abandonAfterMs = options.abandonAfterMs ?? ABANDON_AFTER_MS;
  const backoffAfterMs = options.backoffAfterMs ?? BACKOFF_AFTER_MS;
  const backoffMs = options.backoffMs ?? BACKOFF_MS;

  let consecutiveErrors = 0;
  let failingSince = 0;

  while (true) {
    let conn: T;
    try {
      conn = await listener.accept();
    } catch (e) {
      // Closed by shutdown() — a normal end to the loop.
      if (isListenerClosed(e)) return;

      if (consecutiveErrors === 0) failingSince = now();
      consecutiveErrors++;

      const failingFor = now() - failingSince;
      log(
        `Accept error (${consecutiveErrors}, failing for ${
          seconds(failingFor)
        }): ${e}`,
      );

      if (failingFor >= abandonAfterMs) {
        log(
          `Listener has failed continuously for ${
            seconds(failingFor)
          } — abandoning it`,
        );
        return;
      }

      // Only a sustained run pauses; a burst is retried at full speed.
      if (failingFor >= backoffAfterMs) await sleep(backoffMs);
      continue;
    }

    consecutiveErrors = 0;
    handle(conn).catch((e) => log(`Unhandled connection error: ${e}`));
  }
}
