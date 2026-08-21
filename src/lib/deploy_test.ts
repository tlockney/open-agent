import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildDeployScript,
  HOST_ONLY_COMMANDS,
  REMOTE_COMMANDS,
  SHARED_CLI_MODULES,
} from "./deploy.ts";

// The property that matters. An earlier version of this script did
//   rm -rf ~/.local/share/open-agent/src
// before copying the client-only subset over the top, which deleted
// src/daemon/main.ts on every machine that also ran a daemon — while the
// launchd plist still pointed at it. Those machines kept working until the
// next restart and then could not start at all.
Deno.test("deploy script never removes anything", () => {
  const script = buildDeployScript();
  for (
    const destructive of ["rm ", "rm -rf", "rmdir", "unlink", "find -delete"]
  ) {
    assertEquals(
      script.includes(destructive),
      false,
      `deploy script must not contain '${destructive}'`,
    );
  }
});

Deno.test("deploy script never removes the source tree", () => {
  const script = buildDeployScript();
  assertEquals(script.includes("rm -rf ~/.local/share/open-agent/src"), false);
  // and it overlays contents rather than replacing the directory
  assertStringIncludes(script, "cp -R src/. ~/.local/share/open-agent/src/");
});

Deno.test("deploy script leaves host-only wrappers alone", () => {
  const script = buildDeployScript();

  // Both spellings matter: the script iterates with a `$cmd` loop variable,
  // so checking only the expanded names would pass against a build that
  // deletes every one of them. (It did, until this test was fixed.)
  assertEquals(
    script.includes("rm -f ~/.local/bin/$cmd"),
    false,
    "the host-only loop must not delete its target",
  );
  for (const cmd of HOST_ONLY_COMMANDS) {
    assertEquals(
      script.includes(`rm -f ~/.local/bin/${cmd}`),
      false,
      `${cmd} must not be deleted — the machine may run a daemon`,
    );
  }

  // The loop must still visit them, so the warning is emitted.
  assertStringIncludes(script, `for cmd in ${HOST_ONLY_COMMANDS.join(" ")}`);
});

Deno.test("deploy script warns about orphans instead of deleting them", () => {
  // 165691b's diagnostic value is kept; only the deletion is dropped.
  const script = buildDeployScript();
  assertStringIncludes(script, "oa-warn:");
  assertStringIncludes(script, "left in place");
});

Deno.test("deploy script installs a wrapper for every client command", () => {
  const script = buildDeployScript();
  assertStringIncludes(script, `for cmd in ${REMOTE_COMMANDS.join(" ")}`);
  assertStringIncludes(script, "cp oa-wrapper.sh ~/.local/bin/$cmd");
  assertStringIncludes(script, "chmod +x ~/.local/bin/$cmd");
});

Deno.test("deploy script does not ship host-only commands", () => {
  // They are absent from the install list even though they are not removed.
  for (const cmd of HOST_ONLY_COMMANDS) {
    assertEquals(
      (REMOTE_COMMANDS as readonly string[]).includes(cmd),
      false,
      `${cmd} is host-only and must not be deployed to a remote`,
    );
  }
});

Deno.test("deploy script creates its target directories", () => {
  const script = buildDeployScript();
  assertStringIncludes(script, "mkdir -p ~/.local/share/open-agent/src");
});

Deno.test("deploy script aborts on the first failure", () => {
  assertEquals(buildDeployScript().startsWith("set -e"), true);
});

Deno.test("deploy script honours a custom command list", () => {
  const script = buildDeployScript(["ropen", "ra"]);
  assertStringIncludes(script, "for cmd in ropen ra");
});

// setup-remote packages src/cli/ file-by-file, so a shared module a command
// imports but SHARED_CLI_MODULES omits ships importers without the import —
// every r* command on the remote then dies with "Module not found". (This
// happened when deps.ts was added: remotes got the new ropen.ts without it.)
Deno.test("every ./ import of a shipped CLI script is itself shipped", () => {
  const cliDir = new URL("../cli/", import.meta.url);
  const shipped = new Set<string>([...REMOTE_COMMANDS, ...SHARED_CLI_MODULES]);
  for (const name of shipped) {
    const source = Deno.readTextFileSync(new URL(`${name}.ts`, cliDir));
    for (const match of source.matchAll(/from "\.\/([^"]+)\.ts"/g)) {
      assertEquals(
        shipped.has(match[1]),
        true,
        `${name}.ts imports ./${match[1]}.ts, which setup-remote does not ` +
          "deploy — add it to SHARED_CLI_MODULES in deploy.ts",
      );
    }
  }
});
