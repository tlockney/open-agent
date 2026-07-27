import { assertEquals } from "jsr:@std/assert@1";
import {
  ABANDON_AFTER_MS,
  acceptConnections,
  type AcceptListener,
  type AcceptOptions,
  BACKOFF_AFTER_MS,
} from "./accept.ts";

/**
 * A clock that lets the loop's duration budgets be exercised without any test
 * actually waiting.
 *
 * Reading the time advances it by `tickMs`, mirroring the fact that real time
 * passes whether or not the loop chooses to sleep. Without that, a build with
 * no backoff would freeze the clock, never reach the abandon budget, and spin
 * until the test process died — a hang instead of a failed assertion.
 */
function fakeClock({ tickMs = 1 } = {}) {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    opts: (over: AcceptOptions = {}): AcceptOptions => ({
      now: () => (t += tickMs),
      sleep: (ms: number) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
      ...over,
    }),
  };
}

/** A listener driven by a scripted sequence of accept() outcomes. */
function scriptedListener(
  outcomes: Array<{ conn: string } | { error: unknown }>,
): AcceptListener<string> {
  let i = 0;
  return {
    accept(): Promise<string> {
      if (i >= outcomes.length) {
        // Nothing left to hand out — behave like a closed listener so the
        // loop terminates instead of spinning.
        return Promise.reject(new Deno.errors.BadResource("closed"));
      }
      const outcome = outcomes[i++];
      return "conn" in outcome
        ? Promise.resolve(outcome.conn)
        : Promise.reject(outcome.error);
    },
  };
}

function collector() {
  const handled: string[] = [];
  const logs: string[] = [];
  return {
    handled,
    logs,
    handle: (conn: string) => {
      handled.push(conn);
      return Promise.resolve();
    },
    log: (msg: string) => void logs.push(msg),
  };
}

// The regression this module exists for: macOS returns EINVAL from accept()
// when a client closes between connect() and accept(), which short-lived r*
// commands do routinely. That used to kill the listener on the first one.
Deno.test("acceptConnections: a transient accept error does not stop the loop", async () => {
  const c = collector();
  const listener = scriptedListener([
    { conn: "a" },
    { error: new TypeError("Invalid argument (os error 22)") },
    { conn: "b" },
    { conn: "c" },
  ]);

  await acceptConnections(listener, c.handle, c.log);

  assertEquals(c.handled, ["a", "b", "c"]);
});

Deno.test("acceptConnections: returns cleanly when the listener is closed", async () => {
  const c = collector();
  const listener = scriptedListener([
    { conn: "a" },
    { error: new Deno.errors.BadResource("closed") },
    { conn: "never-reached" },
  ]);

  await acceptConnections(listener, c.handle, c.log);

  assertEquals(c.handled, ["a"]);
  // A shutdown is not an error — it should not be logged as one.
  assertEquals(c.logs, []);
});

Deno.test("acceptConnections: returns cleanly when interrupted", async () => {
  const c = collector();
  const listener = scriptedListener([
    { error: new Deno.errors.Interrupted("interrupted") },
  ]);

  await acceptConnections(listener, c.handle, c.log);

  assertEquals(c.handled, []);
  assertEquals(c.logs, []);
});

Deno.test("acceptConnections: gives up on a listener failing continuously", async () => {
  const c = collector();
  const clock = fakeClock();
  const listener: AcceptListener<string> = {
    accept: () => Promise.reject(new TypeError("permanently broken")),
  };

  await acceptConnections(
    listener,
    c.handle,
    c.log,
    clock.opts({ abandonAfterMs: 200, backoffAfterMs: 0, backoffMs: 50 }),
  );

  assertEquals(c.handled, []);
  // It must not spin forever — that is the whole point of the budget.
  assertEquals(c.logs.at(-1)?.includes("abandoning it"), true);
});

Deno.test("acceptConnections: a sustained failure backs off instead of spinning", async () => {
  // The hazard the budget exists for is a hot loop burning CPU. Backoff is
  // what actually prevents it; giving up is the last resort behind it.
  const c = collector();
  const clock = fakeClock();
  const listener: AcceptListener<string> = {
    accept: () => Promise.reject(new TypeError("permanently broken")),
  };

  await acceptConnections(
    listener,
    c.handle,
    c.log,
    clock.opts({ abandonAfterMs: 1000, backoffAfterMs: 0, backoffMs: 50 }),
  );

  assertEquals(clock.slept.length > 0, true, "a spin must be throttled");
  assertEquals(clock.slept.every((ms) => ms === 50), true);
});

Deno.test("acceptConnections: a short burst is retried without pausing", async () => {
  // Pausing during a burst would stall the listener for as long as clients
  // keep aborting. An early version did exactly that and made the daemon
  // unresponsive for ~27s under a 60-connection burst.
  const c = collector();
  const clock = fakeClock();
  const aborted = { error: new TypeError("Invalid argument (os error 22)") };
  const listener = scriptedListener([
    ...Array(60).fill(aborted),
    { conn: "after-the-burst" },
  ]);

  await acceptConnections(
    listener,
    c.handle,
    c.log,
    clock.opts({ backoffAfterMs: BACKOFF_AFTER_MS }),
  );

  assertEquals(c.handled, ["after-the-burst"]);
  assertEquals(clock.slept, [], "a burst must not pause the listener at all");
});

// The regression that motivated the rewrite: a burst of aborted client
// connections used to trip a 20-in-a-row counter and take the daemon down
// with the listener. A burst is bounded in time, so a duration budget is
// indifferent to how many arrive.
Deno.test("acceptConnections: a burst of aborted connections is survivable", async () => {
  const c = collector();
  const clock = fakeClock();
  const aborted = { error: new TypeError("Invalid argument (os error 22)") };
  const listener = scriptedListener([
    ...Array(50).fill(aborted),
    { conn: "after-the-burst" },
  ]);

  await acceptConnections(
    listener,
    c.handle,
    c.log,
    clock.opts({ abandonAfterMs: ABANDON_AFTER_MS }),
  );

  assertEquals(c.handled, ["after-the-burst"]);
  assertEquals(
    c.logs.some((l) => l.includes("abandoning")),
    false,
    "50 aborted connections must not cost the daemon its listener",
  );
});

Deno.test("acceptConnections: the failure clock restarts after a success", async () => {
  const c = collector();
  const clock = fakeClock();
  const err = { error: new TypeError("Invalid argument (os error 22)") };
  const listener = scriptedListener([
    err,
    err,
    { conn: "a" }, // resets the window, so the next run starts from zero
    err,
    err,
    { conn: "b" },
  ]);

  await acceptConnections(
    listener,
    c.handle,
    c.log,
    clock.opts({ abandonAfterMs: 100, backoffAfterMs: 0, backoffMs: 40 }),
  );

  // Without the reset, four errors at 40ms would have blown a 100ms budget.
  assertEquals(c.handled, ["a", "b"]);
});

Deno.test("the shipped policy leaves ample room above a plausible burst", () => {
  // 25 rapid aborts was enough to kill the old listener. Both budgets are
  // wall-clock, and a burst that size completes in milliseconds.
  assertEquals(BACKOFF_AFTER_MS < ABANDON_AFTER_MS, true);
  assertEquals(ABANDON_AFTER_MS >= 10_000, true);
});
