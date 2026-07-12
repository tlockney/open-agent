import { assertEquals } from "jsr:@std/assert@1";
import { acceptConnections, type AcceptListener } from "./accept.ts";

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

Deno.test("acceptConnections: gives up after too many consecutive errors", async () => {
  const c = collector();
  const listener: AcceptListener<string> = {
    accept: () => Promise.reject(new TypeError("permanently broken")),
  };

  await acceptConnections(listener, c.handle, c.log, 3);

  assertEquals(c.handled, []);
  // Three attempts logged, plus the give-up line — it must not spin forever.
  assertEquals(c.logs.length, 4);
  assertEquals(
    c.logs.at(-1),
    "Too many consecutive accept errors — abandoning listener",
  );
});

Deno.test("acceptConnections: a successful accept resets the error budget", async () => {
  const c = collector();
  const err = { error: new TypeError("Invalid argument (os error 22)") };
  const listener = scriptedListener([
    err,
    err,
    { conn: "a" }, // resets the count, so the next two errors are survivable
    err,
    err,
    { conn: "b" },
  ]);

  await acceptConnections(listener, c.handle, c.log, 3);

  assertEquals(c.handled, ["a", "b"]);
});
