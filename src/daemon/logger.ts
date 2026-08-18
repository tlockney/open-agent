// logger.ts — Daemon logging with file and console output.
//
// The file log is size-capped: once it grows past `maxBytes` the current
// file is rotated to `<path>.1` and a fresh one is opened, so a long-lived
// daemon cannot grow `agent.log` without bound.

/** Default cap before the log rotates to `<path>.1`. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB

let logFile: Deno.FsFile | null = null;
let logPath = "";
let maxLogBytes = MAX_LOG_BYTES;
let bytesWritten = 0;

export async function initLog(
  agentDir: string,
  logPathArg: string,
  maxBytes: number = MAX_LOG_BYTES,
): Promise<void> {
  await Deno.mkdir(agentDir, { recursive: true });
  logPath = logPathArg;
  maxLogBytes = maxBytes;
  logFile = await Deno.open(logPath, {
    write: true,
    create: true,
    append: true,
  });
  // Seed the counter from the existing file so a large pre-existing log
  // rotates on the next write rather than growing forever.
  try {
    bytesWritten = (await Deno.stat(logPath)).size;
  } catch {
    bytesWritten = 0;
  }
}

/**
 * Close the current file, move it aside to `<path>.1`, and reopen a fresh one.
 * Synchronous because `log()` is synchronous; rotation is rare and cheap.
 */
function rotateLog(): void {
  if (!logFile) return;
  try {
    logFile.close();
  } catch { /* already closed */ }
  logFile = null;
  try {
    Deno.removeSync(`${logPath}.1`);
  } catch { /* no previous backup */ }
  try {
    Deno.renameSync(logPath, `${logPath}.1`);
  } catch { /* rename failed — reopen in place */ }
  logFile = Deno.openSync(logPath, {
    write: true,
    create: true,
    append: true,
  });
  bytesWritten = 0;
}

export function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(msg);
  if (!logFile) return;
  const bytes = new TextEncoder().encode(line);
  logFile.writeSync(bytes);
  bytesWritten += bytes.length;
  if (bytesWritten > maxLogBytes) rotateLog();
}

export function closeLog(): void {
  logFile?.close();
  logFile = null;
}
