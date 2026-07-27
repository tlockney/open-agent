// harness.ts — boots a real open-agent daemon for integration tests.
//
// These tests exist because the unit suite is blind to wiring. Two shipped
// bugs proved it: `open-agent status` read response fields the daemon never
// emitted, and a partial-write bug truncated large payloads on the wire.
// Both passed a green unit run; both are caught here.
//
// The daemon under test gets a scratch HOME, so it binds its own socket and
// mount base and cannot disturb a real daemon on the same machine.

import { readMessage, writeMessage } from "../src/lib/framing.ts";

/** Integration tests are opt-in: they spawn processes and need macOS. */
export const INTEGRATION_ENABLED = Deno.env.get("OA_INTEGRATION") === "1";

/** Skip reason surfaced by `deno test` when the suite is not enabled. */
export const SKIP_UNLESS_INTEGRATION = !INTEGRATION_ENABLED;

const SOCKET_WAIT_MS = 30_000;
const SOCKET_POLL_MS = 50;

/**
 * How long to wait for a reply before failing the test.
 *
 * A truncation bug on either side leaves the reader blocked on a newline that
 * never arrives, so without this a regression hangs the job until the CI
 * timeout instead of reporting. Discovered by mutation-testing the suite:
 * reverting writeMessage to a single un-looped write hung the run rather than
 * failing it.
 */
const REPLY_TIMEOUT_MS = 15_000;

/**
 * Scratch HOMEs go under /tmp, not $TMPDIR.
 *
 * macOS caps a Unix socket path at SUN_LEN (104 bytes) and the daemon derives
 * its socket from HOME, appending 45 characters. A per-user $TMPDIR like
 * /var/folders/sw/_2z2…/T/ blows that budget on its own and the daemon dies
 * with "path must be shorter than SUN_LEN".
 */
const TEMP_BASE = "/tmp";

/** Longest HOME that still leaves room for the daemon's socket path. */
const MAX_HOME_LEN = 104 - "/.local/share/open-agent/open-agent.sock".length;

/** Absolute path to the repository root, derived from this file's location. */
export const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunningDaemon {
  /** Unix socket the daemon is listening on. */
  readonly sockPath: string;
  /** The scratch HOME the daemon was given. */
  readonly home: string;
  /** Send a well-formed message and read the reply. */
  request(message: unknown): Promise<Record<string, unknown>>;
  /** Send raw bytes verbatim; returns the reply line, or null on EOF. */
  raw(
    payload: string,
    opts?: { splitInto?: number; gapMs?: number },
  ): Promise<string | null>;
  /** Run one of the project's CLIs against this daemon. */
  cli(script: string, args: string[], env?: Record<string, string>): Promise<
    CommandResult
  >;
  /** Everything the daemon has written to stdout/stderr so far. */
  log(): string;
  stop(): Promise<void>;
}

/** Daemon permissions mirror the launchd plist, minus the socket scoping. */
const DAEMON_PERMS = [
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
  "--allow-net",
];

let denoDirCache: Promise<string> | null = null;

/**
 * The module cache the parent is using.
 *
 * Every child here runs with a scratch HOME, and Deno derives its cache
 * location from HOME unless DENO_DIR says otherwise — so without this each
 * spawned daemon and CLI re-downloads the whole dependency tree into a
 * directory that is deleted moments later. Passing the real cache through
 * keeps the suite offline-capable and turns minutes into seconds.
 */
function denoDir(): Promise<string> {
  denoDirCache ??= (async () => {
    const explicit = Deno.env.get("DENO_DIR");
    if (explicit) return explicit;
    try {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json"],
        stdout: "piped",
        stderr: "null",
      }).output();
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      if (typeof info.denoDir === "string") return info.denoDir;
    } catch { /* fall through to the platform default */ }
    return `${Deno.env.get("HOME") ?? ""}/Library/Caches/deno`;
  })();
  return denoDirCache;
}

/**
 * Wait for the socket, but give up the moment the daemon exits — otherwise a
 * daemon that dies on startup costs the full timeout before reporting, and
 * the useful part (its own error output) arrives 30 seconds late.
 */
async function waitForSocket(
  path: string,
  exited: Promise<unknown>,
  deadlineMs: number,
): Promise<void> {
  let dead = false;
  exited.then(() => dead = true).catch(() => dead = true);

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(path);
      return;
    } catch { /* not yet */ }
    if (dead) throw new Error("daemon exited before it began listening");
    await new Promise((r) => setTimeout(r, SOCKET_POLL_MS));
  }
  throw new Error(`daemon socket did not appear at ${path}`);
}

export interface StartOptions {
  /**
   * Populate the scratch HOME before the daemon boots — used to plant a
   * persisted mount table and observe what startup makes of it.
   */
  seed?: (home: string) => Promise<void>;
}

/**
 * Start a daemon against a scratch HOME and wait until it is listening.
 *
 * The TCP listener may fail to bind when a real daemon already holds 19876.
 * That is the documented degraded path, not an error — every test here talks
 * over the Unix socket.
 */
export async function startDaemon(
  options: StartOptions = {},
): Promise<RunningDaemon> {
  const home = await Deno.makeTempDir({ dir: TEMP_BASE, prefix: "oa-it-" });
  if (home.length > MAX_HOME_LEN) {
    await Deno.remove(home, { recursive: true }).catch(() => {});
    throw new Error(
      `scratch HOME ${home} is too long; the daemon's socket path would ` +
        `exceed the ${104}-byte SUN_LEN limit`,
    );
  }
  const sockPath = `${home}/.local/share/open-agent/open-agent.sock`;
  const cache = await denoDir();

  if (options.seed) {
    await Deno.mkdir(`${home}/.local/share/open-agent`, { recursive: true });
    await options.seed(home);
  }

  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", ...DAEMON_PERMS, `${REPO_ROOT}/src/daemon/main.ts`],
    env: { ...Deno.env.toObject(), HOME: home, DENO_DIR: cache },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drain both streams continuously; a full pipe would wedge the daemon.
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  const draining = Promise.all([drain(child.stdout), drain(child.stderr)]);

  const daemon: RunningDaemon = {
    sockPath,
    home,

    async request(message: unknown): Promise<Record<string, unknown>> {
      const line = await daemon.raw(JSON.stringify(message));
      if (line === null) throw new Error("daemon closed without replying");
      return JSON.parse(line) as Record<string, unknown>;
    },

    async raw(payload, opts): Promise<string | null> {
      const conn = await Deno.connect({ transport: "unix", path: sockPath });
      try {
        const bytes = new TextEncoder().encode(payload);
        const parts = opts?.splitInto ?? 1;
        if (parts <= 1) {
          await writeMessage(conn, payload);
        } else {
          const size = Math.ceil(bytes.length / parts);
          for (let i = 0; i < bytes.length; i += size) {
            const part = bytes.subarray(i, i + size);
            let off = 0;
            while (off < part.length) {
              off += await conn.write(part.subarray(off));
            }
            if (opts?.gapMs) {
              await new Promise((r) => setTimeout(r, opts.gapMs));
            }
          }
        }
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            conn.close();
          } catch { /* already closed */ }
        }, REPLY_TIMEOUT_MS);

        try {
          const line = (await readMessage(conn)).trim();
          return line === "" ? null : line;
        } catch (e) {
          if (timedOut) {
            throw new Error(
              `no reply within ${REPLY_TIMEOUT_MS}ms — truncated or missing ` +
                `newline delimiter?`,
            );
          }
          throw e;
        } finally {
          clearTimeout(timer);
        }
      } finally {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
    },

    async cli(script, args, env): Promise<CommandResult> {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...DAEMON_PERMS,
          `${REPO_ROOT}/src/cli/${script}.ts`,
          ...args,
        ],
        env: {
          ...Deno.env.toObject(),
          HOME: home,
          DENO_DIR: cache,
          OPEN_AGENT_SOCK: sockPath,
          ...env,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    },

    log: () => output,

    async stop(): Promise<void> {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      try {
        await child.status;
      } catch { /* already reaped */ }
      await draining.catch(() => {});
      await Deno.remove(home, { recursive: true }).catch(() => {});
    },
  };

  try {
    await waitForSocket(sockPath, child.status, SOCKET_WAIT_MS);
  } catch (e) {
    await daemon.stop();
    throw new Error(
      `${e instanceof Error ? e.message : e}\n--- daemon output ---\n${output}`,
    );
  }

  return daemon;
}

/**
 * Run `body` against a freshly started daemon and always tear it down.
 * Each test gets its own daemon so state cannot leak between them.
 */
export async function withDaemon(
  body: (daemon: RunningDaemon) => Promise<void>,
): Promise<void> {
  const daemon = await startDaemon();
  try {
    await body(daemon);
  } finally {
    await daemon.stop();
  }
}
