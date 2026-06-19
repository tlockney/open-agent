import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildOpenMessage,
  buildPullMessage,
  buildPushMessage,
  CliError,
  extractAccount,
  isUrl,
  isVsCodeApp,
  parseEnvLine,
  parseRaCommand,
  parseReadRef,
  parseRnotifyArgs,
  parseRopenFlags,
  parseRpullArgs,
  parseRpushArgs,
  splitRunArgs,
} from "./args.ts";

// --- rnotify ---

Deno.test("parseRnotifyArgs: -h yields help", () => {
  assertEquals(parseRnotifyArgs(["-h"]), { kind: "help" });
});

Deno.test("parseRnotifyArgs: title only", () => {
  assertEquals(parseRnotifyArgs(["Build complete"]), {
    kind: "notify",
    message: { action: "notify", title: "Build complete" },
  });
});

Deno.test("parseRnotifyArgs: title and message", () => {
  assertEquals(parseRnotifyArgs(["CI", "All tests passed"]), {
    kind: "notify",
    message: { action: "notify", title: "CI", message: "All tests passed" },
  });
});

Deno.test("parseRnotifyArgs: sound and subtitle flags", () => {
  assertEquals(
    parseRnotifyArgs(["-s", "Ping", "-u", "proj", "Deploy", "done"]),
    {
      kind: "notify",
      message: {
        action: "notify",
        title: "Deploy",
        message: "done",
        subtitle: "proj",
        sound: "Ping",
      },
    },
  );
});

Deno.test("parseRnotifyArgs: numeric positional coerced to string", () => {
  assertEquals(parseRnotifyArgs(["42"]), {
    kind: "notify",
    message: { action: "notify", title: "42" },
  });
});

Deno.test("parseRnotifyArgs: no title throws", () => {
  assertThrows(() => parseRnotifyArgs([]), CliError, "title required");
});

// --- ropen flags ---

Deno.test("parseRopenFlags: bare path", () => {
  assertEquals(parseRopenFlags(["README.md"]), {
    help: false,
    app: "",
    vscode: false,
    positional: ["README.md"],
  });
});

Deno.test("parseRopenFlags: app flag", () => {
  assertEquals(parseRopenFlags(["-a", "Marked 2", "doc.md"]), {
    help: false,
    app: "Marked 2",
    vscode: false,
    positional: ["doc.md"],
  });
});

Deno.test("parseRopenFlags: vscode and help flags", () => {
  assertEquals(parseRopenFlags(["-v", "proj"]).vscode, true);
  assertEquals(parseRopenFlags(["-h"]).help, true);
});

Deno.test("parseRopenFlags: numeric positional coerced", () => {
  assertEquals(parseRopenFlags(["123"]).positional, ["123"]);
});

Deno.test("parseRopenFlags: unknown option throws", () => {
  assertThrows(
    () => parseRopenFlags(["-x", "file"]),
    CliError,
    "Unknown option: -x",
  );
});

// --- ropen helpers ---

Deno.test("isUrl: matches http and https only", () => {
  assertEquals(isUrl("http://x"), true);
  assertEquals(isUrl("https://x"), true);
  assertEquals(isUrl("ftp://x"), false);
  assertEquals(isUrl("/path/to/file"), false);
});

Deno.test("isVsCodeApp: full name and bare Code match, Xcode does not", () => {
  assertEquals(isVsCodeApp("Visual Studio Code"), true);
  assertEquals(isVsCodeApp("Code"), true);
  assertEquals(isVsCodeApp("Xcode"), false);
  assertEquals(isVsCodeApp("Marked 2"), false);
  assertEquals(isVsCodeApp(""), false);
});

// --- buildOpenMessage ---

const OPEN_CTX = { host: "workmbp", home: "/home/me" };

Deno.test("buildOpenMessage: url becomes open-url", () => {
  assertEquals(
    buildOpenMessage({
      target: "https://example.com",
      app: "",
      vscode: false,
      ...OPEN_CTX,
    }),
    { action: "open-url", url: "https://example.com" },
  );
});

Deno.test("buildOpenMessage: vscode flag becomes open-vscode", () => {
  assertEquals(
    buildOpenMessage({ target: "/proj", app: "", vscode: true, ...OPEN_CTX }),
    { action: "open-vscode", host: "workmbp", path: "/proj" },
  );
});

Deno.test("buildOpenMessage: VS Code app name coerces to open-vscode", () => {
  assertEquals(
    buildOpenMessage({
      target: "/proj",
      app: "Visual Studio Code",
      vscode: false,
      ...OPEN_CTX,
    }),
    { action: "open-vscode", host: "workmbp", path: "/proj" },
  );
});

Deno.test("buildOpenMessage: explicit app becomes open with app", () => {
  assertEquals(
    buildOpenMessage({
      target: "/doc.md",
      app: "Marked 2",
      vscode: false,
      ...OPEN_CTX,
    }),
    {
      action: "open",
      host: "workmbp",
      remoteHome: "/home/me",
      path: "/doc.md",
      app: "Marked 2",
    },
  );
});

Deno.test("buildOpenMessage: plain path becomes open without app", () => {
  assertEquals(
    buildOpenMessage({
      target: "/doc.md",
      app: "",
      vscode: false,
      ...OPEN_CTX,
    }),
    {
      action: "open",
      host: "workmbp",
      remoteHome: "/home/me",
      path: "/doc.md",
    },
  );
});

// --- rpush ---

Deno.test("parseRpushArgs: -h yields help", () => {
  assertEquals(parseRpushArgs(["-h"]), { kind: "help" });
});

Deno.test("parseRpushArgs: file only", () => {
  assertEquals(parseRpushArgs(["build.tar.gz"]), {
    kind: "push",
    file: "build.tar.gz",
  });
});

Deno.test("parseRpushArgs: dest flag", () => {
  assertEquals(parseRpushArgs(["-d", "~/Desktop", "report.pdf"]), {
    kind: "push",
    file: "report.pdf",
    dest: "~/Desktop",
  });
});

Deno.test("parseRpushArgs: no file throws", () => {
  assertThrows(() => parseRpushArgs([]), CliError, "file required");
});

Deno.test("buildPushMessage: with and without dest", () => {
  assertEquals(buildPushMessage({ path: "/abs/f", host: "h", home: "/home" }), {
    action: "push",
    host: "h",
    remoteHome: "/home",
    path: "/abs/f",
  });
  assertEquals(
    buildPushMessage({
      path: "/abs/f",
      dest: "~/Desktop",
      host: "h",
      home: "/home",
    }),
    {
      action: "push",
      host: "h",
      remoteHome: "/home",
      path: "/abs/f",
      dest: "~/Desktop",
    },
  );
});

// --- rpull ---

Deno.test("parseRpullArgs: -h and --help yield help", () => {
  assertEquals(parseRpullArgs(["-h"]), { kind: "help" });
  assertEquals(parseRpullArgs(["--help"]), { kind: "help" });
});

Deno.test("parseRpullArgs: local path only", () => {
  assertEquals(parseRpullArgs(["~/Downloads/image.png"]), {
    kind: "pull",
    localPath: "~/Downloads/image.png",
  });
});

Deno.test("parseRpullArgs: local path and remote dest", () => {
  assertEquals(parseRpullArgs(["~/Desktop/notes.md", "~/docs/"]), {
    kind: "pull",
    localPath: "~/Desktop/notes.md",
    remoteDest: "~/docs/",
  });
});

Deno.test("parseRpullArgs: empty args throws", () => {
  assertThrows(() => parseRpullArgs([]), CliError, "local path required");
});

Deno.test("buildPullMessage: builds pull message", () => {
  assertEquals(
    buildPullMessage({
      localPath: "~/Downloads/x.png",
      remoteDest: "/abs/dir",
      host: "h",
      home: "/home",
    }),
    {
      action: "pull",
      host: "h",
      remoteHome: "/home",
      localPath: "~/Downloads/x.png",
      remoteDest: "/abs/dir",
    },
  );
});

// --- rop: extractAccount ---

Deno.test("extractAccount: no account", () => {
  assertEquals(extractAccount(["read", "op://a/b/c"]), {
    rest: ["read", "op://a/b/c"],
  });
});

Deno.test("extractAccount: account before subcommand", () => {
  assertEquals(extractAccount(["--account", "work", "read", "ref"]), {
    account: "work",
    rest: ["read", "ref"],
  });
});

Deno.test("extractAccount: account after subcommand", () => {
  assertEquals(extractAccount(["read", "--account", "work", "ref"]), {
    account: "work",
    rest: ["read", "ref"],
  });
});

Deno.test("extractAccount: dangling --account throws", () => {
  assertThrows(
    () => extractAccount(["read", "--account"]),
    CliError,
    "--account requires a value",
  );
});

// --- rop: parseReadRef ---

Deno.test("parseReadRef: valid op reference", () => {
  assertEquals(parseReadRef(["op://dev/db/url"]), "op://dev/db/url");
});

Deno.test("parseReadRef: missing reference throws", () => {
  assertThrows(
    () => parseReadRef([]),
    CliError,
    "read requires an op:// reference",
  );
});

Deno.test("parseReadRef: non-op reference throws", () => {
  assertThrows(
    () => parseReadRef(["not-a-ref"]),
    CliError,
    "reference must start with op://",
  );
});

// --- rop: splitRunArgs ---

Deno.test("splitRunArgs: command with no env files", () => {
  assertEquals(splitRunArgs(["--", "make", "deploy"]), {
    envFiles: [],
    cmdArgs: ["make", "deploy"],
  });
});

Deno.test("splitRunArgs: single env file", () => {
  assertEquals(
    splitRunArgs(["--env-file", ".env", "--", "terraform", "apply"]),
    {
      envFiles: [".env"],
      cmdArgs: ["terraform", "apply"],
    },
  );
});

Deno.test("splitRunArgs: multiple env files", () => {
  assertEquals(
    splitRunArgs([
      "--env-file",
      ".env",
      "--env-file",
      ".env.local",
      "--",
      "make",
      "test",
    ]),
    {
      envFiles: [".env", ".env.local"],
      cmdArgs: ["make", "test"],
    },
  );
});

Deno.test("splitRunArgs: dangling --env-file throws", () => {
  assertThrows(
    () => splitRunArgs(["--env-file"]),
    CliError,
    "--env-file requires a filename",
  );
});

Deno.test("splitRunArgs: stray argument before -- throws", () => {
  assertThrows(
    () => splitRunArgs(["oops", "--", "make"]),
    CliError,
    "unexpected argument before --: oops",
  );
});

Deno.test("splitRunArgs: missing separator throws", () => {
  assertThrows(
    () => splitRunArgs(["--env-file", ".env"]),
    CliError,
    "missing -- separator before command",
  );
});

Deno.test("splitRunArgs: empty command after -- throws", () => {
  assertThrows(
    () => splitRunArgs(["--"]),
    CliError,
    "no command specified after --",
  );
});

// --- rop: parseEnvLine ---

Deno.test("parseEnvLine: blank and comment lines return null", () => {
  assertEquals(parseEnvLine(""), null);
  assertEquals(parseEnvLine("   "), null);
  assertEquals(parseEnvLine("# a comment"), null);
  assertEquals(parseEnvLine("  # indented comment"), null);
});

Deno.test("parseEnvLine: unparseable line returns null", () => {
  assertEquals(parseEnvLine("not an assignment"), null);
});

Deno.test("parseEnvLine: plain value", () => {
  assertEquals(parseEnvLine("FOO=bar"), {
    key: "FOO",
    value: "bar",
    isRef: false,
  });
});

Deno.test("parseEnvLine: strips surrounding quotes", () => {
  assertEquals(parseEnvLine('FOO="bar baz"'), {
    key: "FOO",
    value: "bar baz",
    isRef: false,
  });
  assertEquals(parseEnvLine("FOO='bar'"), {
    key: "FOO",
    value: "bar",
    isRef: false,
  });
});

Deno.test("parseEnvLine: op:// value flagged as reference", () => {
  assertEquals(parseEnvLine("DB=op://dev/database/url"), {
    key: "DB",
    value: "op://dev/database/url",
    isRef: true,
  });
});

Deno.test("parseEnvLine: whitespace after equals is trimmed", () => {
  assertEquals(parseEnvLine("FOO=  bar"), {
    key: "FOO",
    value: "bar",
    isRef: false,
  });
});

// --- ra ---

Deno.test("parseRaCommand: empty yields help", () => {
  assertEquals(parseRaCommand([]), { kind: "help" });
});

Deno.test("parseRaCommand: help aliases", () => {
  assertEquals(parseRaCommand(["help"]), { kind: "help" });
  assertEquals(parseRaCommand(["--help"]), { kind: "help" });
  assertEquals(parseRaCommand(["-h"]), { kind: "help" });
});

Deno.test("parseRaCommand: simple subcommands", () => {
  for (const cmd of ["ping", "status", "mounts", "doctor"] as const) {
    assertEquals(parseRaCommand([cmd]), { kind: "run", command: cmd });
  }
});

Deno.test("parseRaCommand: reset without host", () => {
  assertEquals(parseRaCommand(["reset"]), { kind: "run", command: "reset" });
});

Deno.test("parseRaCommand: reset with host", () => {
  assertEquals(parseRaCommand(["reset", "workmbp"]), {
    kind: "run",
    command: "reset",
    host: "workmbp",
  });
});

Deno.test("parseRaCommand: unknown command throws", () => {
  assertThrows(
    () => parseRaCommand(["bogus"]),
    CliError,
    "unknown command: bogus",
  );
});
