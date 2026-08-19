// deps.ts — the effect boundary for the r* CLI scripts.
//
// Every CLI script used to execute at import and call Deno.exit, which made
// them impossible to import in a unit test. Each now exports a `main(argv,
// deps)` function that takes its effects as a `CliDeps`; the entry point
// (guarded by `import.meta.main`) calls it with `realDeps`. Tests can import
// the module and call `main` with fakes.

import type { Message, OkResponse, Response } from "../lib/messages.ts";
import { existsSync } from "jsr:@std/fs@1/exists";
import {
  checkResponse,
  fail,
  formatErrorMessage,
  getStringField,
  isRemoteSession,
  requireHost,
  requireSock,
  send,
} from "../lib/oa.ts";

/** Result of a piped subprocess run. */
export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Options for `deps.run`. */
export interface RunOpts {
  stdin?: "inherit" | "null" | "piped";
  input?: Uint8Array;
  timeout?: number;
}

/** A spawned process with piped stdin (e.g. `pbcopy`). */
export interface PipedProcess {
  stdin: WritableStream<Uint8Array>;
  status: Promise<number>;
}

/**
 * The effects a CLI needs. Everything that touches the outside world goes
 * through this interface so tests can substitute fakes.
 */
export interface CliDeps {
  // --- transport + shared helpers (from lib/oa.ts) ---
  send(message: Message, timeoutSec?: number): Promise<Response>;
  fail(msg: string): never;
  checkResponse(response: Response): asserts response is OkResponse;
  formatErrorMessage(err: unknown): string;
  requireHost(host?: string): string;
  requireSock(): void;
  getStringField(response: Response, key: string): string;
  isRemoteSession(): boolean;

  // --- subprocess ---
  /** Run a subprocess with piped stdio and capture its output. */
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  /** Run a subprocess with inherited stdio; resolves to its exit code. */
  exec(
    cmd: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<number>;
  /** Spawn a subprocess with piped stdin (for feeding it data). */
  spawnPiped(cmd: string): PipedProcess;

  // --- process ---
  exit(code: number): never;

  // --- environment ---
  env: {
    get(name: string): string | undefined;
    toObject(): Record<string, string>;
    set(name: string, value: string): void;
  };

  // --- filesystem ---
  cwd(): string;
  realPathSync(p: string): string;
  statSync(p: string): { isDirectory: boolean };
  readTextFileSync(p: string): string;
  existsSync(p: string): boolean;
  makeTempDirSync(): string;
  copyFile(src: string, dest: string): Promise<void>;
  readFile(p: string): Promise<Uint8Array>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(p: string, opts?: { recursive?: boolean }): Promise<void>;
  readDir(
    p: string,
  ): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>;

  // --- stdio ---
  stdin: { isTerminal(): boolean; readable: ReadableStream<Uint8Array> };
  stdout: { write(bytes: Uint8Array): Promise<number> };
}

const decoder = new TextDecoder();

/** The production `CliDeps`, backed by real Deno APIs. */
export const realDeps: CliDeps = {
  send,
  fail,
  checkResponse,
  formatErrorMessage,
  requireHost,
  requireSock,
  getStringField,
  isRemoteSession,

  async run(cmd, args, opts) {
    const command = new Deno.Command(cmd, {
      args,
      stdin: opts?.stdin ?? "null",
      stdout: "piped",
      stderr: "piped",
      signal: opts?.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
    });
    try {
      let child: Deno.CommandOutput;
      if (opts?.input) {
        const proc = command.spawn();
        const writer = proc.stdin.getWriter();
        await writer.write(opts.input);
        await writer.close();
        child = await proc.output();
      } else {
        child = await command.output();
      }
      return {
        success: child.success,
        stdout: decoder.decode(child.stdout).trim(),
        stderr: decoder.decode(child.stderr).trim(),
        code: child.code,
      };
    } catch {
      return { success: false, stdout: "", stderr: "command failed", code: 1 };
    }
  },

  async exec(cmd, args, env) {
    const { code } = await new Deno.Command(cmd, {
      args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      ...(env ? { env } : {}),
    }).output();
    return code;
  },

  spawnPiped(cmd) {
    const proc = new Deno.Command(cmd, { stdin: "piped" }).spawn();
    return {
      stdin: proc.stdin,
      status: proc.status.then((s) => s.code),
    };
  },

  exit: (code) => Deno.exit(code),

  env: {
    get: (name) => Deno.env.get(name),
    toObject: () => Deno.env.toObject(),
    set: (name, value) => Deno.env.set(name, value),
  },

  cwd: () => Deno.cwd(),
  realPathSync: (p) => Deno.realPathSync(p),
  statSync: (p) => Deno.statSync(p),
  readTextFileSync: (p) => Deno.readTextFileSync(p),
  existsSync: (p) => existsSync(p),
  makeTempDirSync: () => Deno.makeTempDirSync(),
  copyFile: (src, dest) => Deno.copyFile(src, dest),
  readFile: (p) => Deno.readFile(p),
  mkdir: (p, opts) => Deno.mkdir(p, opts),
  remove: (p, opts) => Deno.remove(p, opts),
  readDir: (p) => Deno.readDir(p),

  stdin: {
    isTerminal: () => Deno.stdin.isTerminal(),
    readable: Deno.stdin.readable,
  },
  stdout: {
    write: (bytes) => Deno.stdout.write(bytes),
  },
};
