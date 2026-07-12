// accept.ts — the daemon's accept loop.
//
// Split out from main.ts so the retry/teardown policy can be tested without
// binding real sockets.

/** The slice of Deno.Listener the accept loop needs. */
export interface AcceptListener<T> {
  accept(): Promise<T>;
}

/**
 * A single accept() can fail without the listener being dead. macOS returns
 * EINVAL (os error 22) when a client closes between connect() and accept(),
 * which any short-lived r* command does routinely. Treating that as fatal
 * tore down the Unix listener on the first such connection and took the
 * daemon with it, so accept errors are per-connection noise by default.
 *
 * A listener that fails this many times in a row is genuinely broken (rather
 * than seeing transient client behaviour) and the loop gives up, letting the
 * caller decide whether to exit.
 */
export const MAX_CONSECUTIVE_ACCEPT_ERRORS = 20;

/** True when the error means the listener itself is gone, not the connection. */
function isListenerClosed(e: unknown): boolean {
  return e instanceof Deno.errors.BadResource ||
    e instanceof Deno.errors.Interrupted;
}

/**
 * Accept connections until the listener closes or fails repeatedly, handing
 * each one to `handle`. Resolves when the loop stops; never rejects.
 */
export async function acceptConnections<T>(
  listener: AcceptListener<T>,
  handle: (conn: T) => Promise<void>,
  log: (msg: string) => void,
  maxConsecutiveErrors: number = MAX_CONSECUTIVE_ACCEPT_ERRORS,
): Promise<void> {
  let consecutiveErrors = 0;

  while (true) {
    let conn: T;
    try {
      conn = await listener.accept();
    } catch (e) {
      // Closed by shutdown() — a normal end to the loop.
      if (isListenerClosed(e)) return;

      consecutiveErrors++;
      log(
        `Accept error (${consecutiveErrors}/${maxConsecutiveErrors}): ${e}`,
      );
      if (consecutiveErrors >= maxConsecutiveErrors) {
        log("Too many consecutive accept errors — abandoning listener");
        return;
      }
      continue;
    }

    consecutiveErrors = 0;
    handle(conn).catch((e) => log(`Unhandled connection error: ${e}`));
  }
}
