import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type ByteReader,
  MAX_MESSAGE_BYTES,
  MessageTooLargeError,
  readMessage,
  writeMessage,
} from "./framing.ts";

/** A reader that hands back a scripted sequence of byte slices, then EOF. */
function scriptedReader(pieces: (string | Uint8Array)[]): ByteReader {
  const queue = pieces.map((p) =>
    typeof p === "string" ? new TextEncoder().encode(p) : p
  );
  let pending: Uint8Array | null = null;

  return {
    read(p: Uint8Array): Promise<number | null> {
      if (!pending || pending.length === 0) {
        const next = queue.shift();
        if (!next) return Promise.resolve(null);
        pending = next;
      }
      const n = Math.min(p.length, pending.length);
      p.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return Promise.resolve(n);
    },
  };
}

Deno.test("readMessage: reads a single newline-terminated line", async () => {
  const reader = scriptedReader(['{"action":"ping"}\n']);
  assertEquals(await readMessage(reader), '{"action":"ping"}');
});

Deno.test("readMessage: reassembles a message split across reads", async () => {
  // The regression this module exists for: TCP has no message boundaries,
  // so a payload can arrive in pieces even when it is far below any cap.
  const reader = scriptedReader(['{"action":', '"pi', 'ng"}', "\n"]);
  assertEquals(await readMessage(reader), '{"action":"ping"}');
});

Deno.test("readMessage: reads a payload larger than one chunk", async () => {
  const content = "x".repeat(50_000);
  const line = JSON.stringify({ action: "copy", content }) + "\n";
  const reader = scriptedReader([line]);

  const got = await readMessage(reader);
  assertEquals(got.length, line.length - 1);
  assertEquals(JSON.parse(got).content.length, 50_000);
});

Deno.test("readMessage: EOF terminates a message with no trailing newline", async () => {
  const reader = scriptedReader(['{"action":"ping"}']);
  assertEquals(await readMessage(reader), '{"action":"ping"}');
});

Deno.test("readMessage: immediate EOF yields an empty string", async () => {
  assertEquals(await readMessage(scriptedReader([])), "");
});

Deno.test("readMessage: stops at the first newline and drops the rest", async () => {
  const reader = scriptedReader(['{"a":1}\n{"b":2}\n']);
  assertEquals(await readMessage(reader), '{"a":1}');
});

Deno.test("readMessage: preserves multi-byte UTF-8 split across reads", async () => {
  // "é" is two bytes; split them across separate reads so a per-chunk
  // decode would produce replacement characters.
  const bytes = new TextEncoder().encode("café\n");
  const reader = scriptedReader([
    bytes.subarray(0, 4),
    bytes.subarray(4),
  ]);
  assertEquals(await readMessage(reader), "café");
});

Deno.test("readMessage: rejects a message over the cap", async () => {
  const reader = scriptedReader(["y".repeat(1000)]);
  await assertRejects(
    () => readMessage(reader, 100),
    MessageTooLargeError,
    "exceeds maximum size",
  );
});

Deno.test("readMessage: a message exactly at the cap is accepted", async () => {
  const reader = scriptedReader(["z".repeat(100) + "\n"]);
  assertEquals((await readMessage(reader, 100)).length, 100);
});

Deno.test("readMessage: the cap counts payload, not the newline", async () => {
  // 100 payload bytes plus a delimiter must not trip a 100-byte cap.
  const reader = scriptedReader(["z".repeat(100), "\n"]);
  assertEquals((await readMessage(reader, 100)).length, 100);
});

Deno.test("MAX_MESSAGE_BYTES is large enough for a sizable clipboard", () => {
  assertEquals(MAX_MESSAGE_BYTES >= 1_000_000, true);
});

// --- writeMessage ---

/** A writer that accepts at most `limit` bytes per call, like a real socket. */
function chunkedWriter(limit: number) {
  const written: number[] = [];
  const calls: number[] = [];
  return {
    calls,
    text: () => new TextDecoder().decode(new Uint8Array(written)),
    write(p: Uint8Array): Promise<number> {
      const n = Math.min(limit, p.length);
      written.push(...p.subarray(0, n));
      calls.push(n);
      return Promise.resolve(n);
    },
  };
}

Deno.test("writeMessage: appends the newline delimiter", async () => {
  const w = chunkedWriter(4096);
  await writeMessage(w, '{"ok":true}');
  assertEquals(w.text(), '{"ok":true}\n');
});

Deno.test("writeMessage: does not double the newline", async () => {
  const w = chunkedWriter(4096);
  await writeMessage(w, '{"ok":true}\n');
  assertEquals(w.text(), '{"ok":true}\n');
});

Deno.test("writeMessage: loops until a partial-accepting writer takes it all", async () => {
  // The regression: one un-looped write() truncates anything past the
  // socket buffer, and the reader then waits forever for the newline.
  const payload = JSON.stringify({ ok: true, content: "q".repeat(50_000) });
  const w = chunkedWriter(8192);

  await writeMessage(w, payload);

  assertEquals(w.text(), payload + "\n");
  assertEquals(w.calls.length > 1, true);
});

Deno.test("writeMessage: round-trips through readMessage", async () => {
  const payload = JSON.stringify({ ok: true, content: "r".repeat(70_000) });
  const w = chunkedWriter(1024);
  await writeMessage(w, payload);

  const reader = scriptedReader([new TextEncoder().encode(w.text())]);
  assertEquals(await readMessage(reader), payload);
});

Deno.test("writeMessage: throws if the writer stops accepting bytes", async () => {
  const stalled = { write: (_p: Uint8Array) => Promise.resolve(0) };
  await assertRejects(
    () => writeMessage(stalled, "anything"),
    Error,
    "accepted no bytes",
  );
});
