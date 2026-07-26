// framing.ts — newline-delimited message framing, shared by both sides.
//
// The protocol is one line of JSON per connection, but a socket read is not
// a message read: TCP has no message boundaries, so a payload can arrive
// split across several reads regardless of its size. Reading a single fixed
// buffer once therefore truncated large or segmented messages and surfaced
// them as an unexplained parse failure.

/** The slice of `Deno.Conn` the reader needs. */
export interface ByteReader {
  read(p: Uint8Array): Promise<number | null>;
}

/** The slice of `Deno.Conn` the writer needs. */
export interface ByteWriter {
  write(p: Uint8Array): Promise<number>;
}

const NEWLINE = 0x0a;

/** Default read granularity. Messages are usually far smaller than this. */
export const CHUNK_BYTES = 8192;

/**
 * Cap on one message. Generous enough for a large clipboard through
 * `rcopy`, bounded so a peer cannot make the daemon allocate without limit.
 */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Raised when a peer sends more than `maxBytes` without a newline. */
export class MessageTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`message exceeds maximum size (${maxBytes} bytes)`);
    this.name = "MessageTooLargeError";
  }
}

/**
 * Read one newline-terminated message and return it without the newline.
 *
 * EOF also terminates the message: a peer that writes a payload and closes
 * without a trailing newline has still sent everything it intends to, and
 * rejecting that would be gratuitously strict. An immediate EOF yields "".
 * Anything after the first newline is discarded — one request per
 * connection is the whole protocol.
 */
export async function readMessage(
  reader: ByteReader,
  maxBytes: number = MAX_MESSAGE_BYTES,
  chunkSize: number = CHUNK_BYTES,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    // A fresh buffer per iteration: the pushed subarrays are views, so
    // reusing one buffer would let a later read overwrite earlier chunks.
    const buf = new Uint8Array(chunkSize);
    const n = await reader.read(buf);
    if (n === null || n === 0) break;

    const chunk = buf.subarray(0, n);
    const nl = chunk.indexOf(NEWLINE);
    const keep = nl === -1 ? chunk : chunk.subarray(0, nl);

    if (total + keep.length > maxBytes) {
      throw new MessageTooLargeError(maxBytes);
    }
    chunks.push(keep);
    total += keep.length;

    if (nl !== -1) break;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(out);
}

/**
 * Write one newline-terminated message, looping until every byte is out.
 *
 * The mirror of `readMessage`'s problem: `Deno.Conn.write` resolves with the
 * number of bytes it actually took, which for a payload past the socket
 * buffer is less than it was given. A single un-looped write therefore
 * truncated large responses on the wire, and the peer — correctly waiting
 * for a newline that was never sent — hung until its timeout.
 */
export async function writeMessage(
  writer: ByteWriter,
  message: string,
): Promise<void> {
  const line = message.endsWith("\n") ? message : message + "\n";
  const bytes = new TextEncoder().encode(line);

  let offset = 0;
  while (offset < bytes.length) {
    const n = await writer.write(bytes.subarray(offset));
    if (n <= 0) throw new Error("connection accepted no bytes");
    offset += n;
  }
}
