// logger.ts — Daemon logging with file and console output.

let logFile: Deno.FsFile | null = null;

export async function initLog(agentDir: string, logPath: string): Promise<void> {
  await Deno.mkdir(agentDir, { recursive: true });
  logFile = await Deno.open(logPath, {
    write: true,
    create: true,
    append: true,
  });
}

export function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(msg);
  logFile?.writeSync(new TextEncoder().encode(line));
}

export function closeLog(): void {
  logFile?.close();
  logFile = null;
}
