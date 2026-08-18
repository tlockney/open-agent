import { assertEquals } from "jsr:@std/assert@1";
import { main } from "./ropen.ts";
import type { CliDeps } from "./deps.ts";
import type { Message } from "../lib/messages.ts";

// Importing the module must not execute anything (the old CLIs ran at import
// and called Deno.exit). Reaching this test at all proves that.

/** A CliDeps with harmless defaults; override the bits a test cares about. */
function fakeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    send: async () => ({ ok: true }),
    fail: (msg) => {
      throw new Error(msg);
    },
    checkResponse: () => {},
    formatErrorMessage: (e) => String(e),
    requireHost: () => "workmbp",
    requireSock: () => {},
    getStringField: (r, k) => (r as Record<string, unknown>)[k] as string ?? "",
    isRemoteSession: () => true,
    run: async () => ({ success: true, stdout: "", stderr: "", code: 0 }),
    exec: async () => 0,
    spawnPiped: () => {
      throw new Error("not used");
    },
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    env: { get: () => "/home/me", toObject: () => ({}), set: () => {} },
    cwd: () => "/cwd",
    realPathSync: (p) => p,
    statSync: () => ({ isDirectory: false }),
    readTextFileSync: () => "",
    existsSync: () => true,
    makeTempDirSync: () => "/tmp",
    copyFile: async () => {},
    readFile: async () => new Uint8Array(),
    mkdir: async () => {},
    remove: async () => {},
    readDir: async function* () {},
    stdin: { isTerminal: () => false, readable: new ReadableStream() },
    stdout: { write: async () => 0 },
    ...overrides,
  };
}

Deno.test("ropen main sends an open message for a remote path", async () => {
  let sent: Message | undefined;
  const deps = fakeDeps({
    send: async (msg) => {
      sent = msg;
      return { ok: true, localPath: "/mnt/work/docs/report.md" };
    },
  });

  await main(["/home/me/docs/report.md"], deps);

  assertEquals(sent, {
    action: "open",
    host: "workmbp",
    remoteHome: "/home/me",
    path: "/home/me/docs/report.md",
  });
});

Deno.test("ropen main sends open-url for a URL", async () => {
  let sent: Message | undefined;
  const deps = fakeDeps({
    send: async (msg) => {
      sent = msg;
      return { ok: true };
    },
  });

  await main(["https://example.com"], deps);

  assertEquals(sent, { action: "open-url", url: "https://example.com" });
});
