// state_test.ts — what the daemon makes of a persisted mount table at startup.
//
// The unit tests drive reconciliation through fake deps; this checks the real
// daemon reads the real file, runs the real mount(8), and reports the result
// through `ra mounts`. No sshfs is involved: every seeded entry points at a
// mount that does not exist, which is exactly the case a restart leaves behind
// once the mounts have been torn down.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { SKIP_UNLESS_INTEGRATION, startDaemon } from "./harness.ts";

const STATE = ".local/share/open-agent/mounts.json";

const write = (body: string) => async (home: string) => {
  await Deno.writeTextFile(`${home}/${STATE}`, body);
};

Deno.test({
  name: "state",
  ignore: SKIP_UNLESS_INTEGRATION,
  async fn(t) {
    await t.step("a stale record is dropped at startup", async () => {
      const daemon = await startDaemon({
        seed: write(JSON.stringify({
          version: 1,
          mounts: [{
            host: "ghost",
            remoteHome: "/home/ghost",
            mountPoint: "/tmp/definitely-not-mounted-oa",
          }],
        })),
      });
      try {
        assertStringIncludes(daemon.log(), "Dropped 1 stale mount record");

        const r = await daemon.cli("ra", ["mounts"]);
        assertEquals(r.code, 0, r.stderr);
        assertStringIncludes(r.stdout, "No active mounts");

        // and the pruned table is written back
        const after = JSON.parse(
          await Deno.readTextFile(`${daemon.home}/${STATE}`),
        );
        assertEquals(after.mounts, []);
      } finally {
        await daemon.stop();
      }
    });

    await t.step(
      "a malformed state file does not stop the daemon",
      async () => {
        const daemon = await startDaemon({ seed: write("{ not json at all") });
        try {
          assertStringIncludes(daemon.log(), "unreadable mount state");
          const r = await daemon.cli("ra", ["ping"]);
          assertEquals(r.code, 0, r.stderr);
        } finally {
          await daemon.stop();
        }
      },
    );

    await t.step("no state file is the normal first-run case", async () => {
      const daemon = await startDaemon();
      try {
        assert(
          !daemon.log().includes("mount state"),
          "a first run should say nothing about mount state",
        );
        const r = await daemon.cli("ra", ["mounts"]);
        assertStringIncludes(r.stdout, "No active mounts");
      } finally {
        await daemon.stop();
      }
    });
  },
});
