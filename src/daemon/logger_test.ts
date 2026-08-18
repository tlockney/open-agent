import { assert } from "jsr:@std/assert@1";
import { closeLog, initLog, log } from "./logger.ts";

Deno.test("logger rotates the file once it exceeds the cap", async () => {
  const dir = await Deno.makeTempDir();
  const logPath = `${dir}/agent.log`;
  try {
    // Tiny cap so a handful of lines trips the rotation.
    await initLog(dir, logPath, 100);

    for (let i = 0; i < 20; i++) {
      log(`line ${i} padding padding padding padding padding`);
    }
    closeLog();

    const rotated = await Deno.stat(`${logPath}.1`).catch(() => null);
    const current = await Deno.stat(logPath).catch(() => null);

    assert(rotated !== null, "a rotated backup should exist");
    assert(current !== null, "a fresh log should exist");
    // The current file must stay near the cap rather than growing without
    // bound across the whole run.
    assert(
      current.size <= 200,
      `current log should stay near the cap, got ${current.size} bytes`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
