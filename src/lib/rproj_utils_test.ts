import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  buildFzfEntries,
  parseArgs,
  type ProjectEntry,
  shellQuote,
  splitHostQualifier,
  TERMINAL_RESTORE_SEQUENCE,
} from "./rproj_utils.ts";

// --- splitHostQualifier ---

Deno.test("splitHostQualifier: no colon is a bare project name", () => {
  assertEquals(splitHostQualifier("personal"), {
    host: null,
    name: "personal",
  });
});

Deno.test("splitHostQualifier: host:name splits into both parts", () => {
  assertEquals(splitHostQualifier("m4mini:personal"), {
    host: "m4mini",
    name: "personal",
  });
});

Deno.test("splitHostQualifier: trailing colon yields empty name", () => {
  assertEquals(splitHostQualifier("m4mini:"), { host: "m4mini", name: "" });
});

Deno.test("splitHostQualifier: splits on the first colon only", () => {
  assertEquals(splitHostQualifier("m4mini:sub:dir"), {
    host: "m4mini",
    name: "sub:dir",
  });
});

Deno.test("splitHostQualifier: empty string is a bare (empty) name", () => {
  assertEquals(splitHostQualifier(""), { host: null, name: "" });
});

Deno.test("splitHostQualifier: leading colon (empty host) throws", () => {
  assertThrows(() => splitHostQualifier(":personal"), Error, "empty host");
});

// --- shellQuote ---

Deno.test("shellQuote: simple string", () => {
  assertEquals(shellQuote("hello"), "'hello'");
});

Deno.test("shellQuote: empty string", () => {
  assertEquals(shellQuote(""), "''");
});

Deno.test("shellQuote: string with single quote", () => {
  assertEquals(shellQuote("it's"), "'it'\\''s'");
});

Deno.test("shellQuote: string with multiple single quotes", () => {
  assertEquals(shellQuote("a'b'c"), "'a'\\''b'\\''c'");
});

Deno.test("shellQuote: string with spaces", () => {
  assertEquals(shellQuote("hello world"), "'hello world'");
});

Deno.test("shellQuote: string with double quotes", () => {
  assertEquals(shellQuote('say "hi"'), "'say \"hi\"'");
});

Deno.test("shellQuote: string with backslash", () => {
  assertEquals(shellQuote("back\\slash"), "'back\\slash'");
});

// --- buildFzfEntries ---

Deno.test("buildFzfEntries: empty list", () => {
  assertEquals(buildFzfEntries([]), "");
});

Deno.test("buildFzfEntries: single parent entry", () => {
  const projects: ProjectEntry[] = [
    {
      host: "h1",
      baseDir: "/src/projects",
      projectPath: "/src/projects",
      label: "Work",
    },
  ];
  const result = buildFzfEntries(projects);
  assertEquals(result, "h1|/src/projects\t\u{1F4C2} Work");
});

Deno.test("buildFzfEntries: parent with children", () => {
  const projects: ProjectEntry[] = [
    { host: "h1", baseDir: "/src", projectPath: "/src", label: "Work" },
    { host: "h1", baseDir: "/src", projectPath: "/src/alpha", label: "Work" },
    { host: "h1", baseDir: "/src", projectPath: "/src/beta", label: "Work" },
  ];
  const lines = buildFzfEntries(projects).split("\n");
  assertEquals(lines.length, 3);
  // Parent
  assertEquals(lines[0], "h1|/src\t\u{1F4C2} Work");
  // First child uses ├──
  assertEquals(lines[1], "h1|/src/alpha\t   \u251C\u2500\u2500 alpha");
  // Last child uses └──
  assertEquals(lines[2], "h1|/src/beta\t   \u2514\u2500\u2500 beta");
});

Deno.test("buildFzfEntries: multiple hosts/labels", () => {
  const projects: ProjectEntry[] = [
    { host: "h1", baseDir: "/src", projectPath: "/src", label: "Work" },
    { host: "h1", baseDir: "/src", projectPath: "/src/app", label: "Work" },
    {
      host: "h2",
      baseDir: "/home/dev",
      projectPath: "/home/dev",
      label: "Personal",
    },
    {
      host: "h2",
      baseDir: "/home/dev",
      projectPath: "/home/dev/blog",
      label: "Personal",
    },
  ];
  const lines = buildFzfEntries(projects).split("\n");
  assertEquals(lines.length, 4);
  // Work group
  assertEquals(lines[0], "h1|/src\t\u{1F4C2} Work");
  assertEquals(lines[1], "h1|/src/app\t   \u2514\u2500\u2500 app");
  // Personal group
  assertEquals(lines[2], "h2|/home/dev\t\u{1F4C2} Personal");
  assertEquals(lines[3], "h2|/home/dev/blog\t   \u2514\u2500\u2500 blog");
});

// --- TERMINAL_RESTORE_SEQUENCE ---

Deno.test("TERMINAL_RESTORE_SEQUENCE: leaves alternate screen", () => {
  assertStringIncludes(TERMINAL_RESTORE_SEQUENCE, "\x1b[?1049l");
});

Deno.test("TERMINAL_RESTORE_SEQUENCE: disables every mouse tracking mode", () => {
  // Both axes must be cleared — newer modes don't reliably replace older
  // ones, so leaving any of these on can keep events flowing.
  for (const code of ["9", "1000", "1001", "1002", "1003"]) {
    assertStringIncludes(TERMINAL_RESTORE_SEQUENCE, `\x1b[?${code}l`);
  }
});

Deno.test("TERMINAL_RESTORE_SEQUENCE: disables every mouse encoding mode", () => {
  // 1015 (URxvt) specifically was the leak fixed here — keep all four.
  for (const code of ["1005", "1006", "1015", "1016"]) {
    assertStringIncludes(TERMINAL_RESTORE_SEQUENCE, `\x1b[?${code}l`);
  }
});

Deno.test("TERMINAL_RESTORE_SEQUENCE: disables focus events and bracketed paste", () => {
  assertStringIncludes(TERMINAL_RESTORE_SEQUENCE, "\x1b[?1004l");
  assertStringIncludes(TERMINAL_RESTORE_SEQUENCE, "\x1b[?2004l");
});

Deno.test("TERMINAL_RESTORE_SEQUENCE: restores cursor and default G0 charset", () => {
  assertStringIncludes(TERMINAL_RESTORE_SEQUENCE, "\x1b[?25h");
  assertStringIncludes(TERMINAL_RESTORE_SEQUENCE, "\x1b(B");
});

// --- parseArgs ---

const NO_OPTS = { hostFilter: null, projectName: null };

Deno.test("parseArgs: no args is interactive default", () => {
  assertEquals(parseArgs([]), {
    command: { cmd: "default", opts: NO_OPTS },
    debug: false,
  });
});

Deno.test("parseArgs: bare --debug sets debug on default", () => {
  assertEquals(parseArgs(["--debug"]), {
    command: { cmd: "default", opts: NO_OPTS },
    debug: true,
  });
});

Deno.test("parseArgs: short aliases map to commands", () => {
  assertEquals(parseArgs(["l"]).command, {
    cmd: "list",
    opts: NO_OPTS,
    json: false,
    query: "",
  });
  assertEquals(parseArgs(["t"]).command, { cmd: "tmux", opts: NO_OPTS });
  assertEquals(parseArgs(["c"]).command, { cmd: "code", opts: NO_OPTS });
  assertEquals(parseArgs(["f"]).command, { cmd: "finder", opts: NO_OPTS });
  assertEquals(parseArgs(["s"]).command, { cmd: "status" });
});

Deno.test("parseArgs: help and status commands", () => {
  assertEquals(parseArgs(["help"]).command, { cmd: "help" });
  assertEquals(parseArgs(["--help"]).command, { cmd: "help" });
  assertEquals(parseArgs(["status"]).command, { cmd: "status" });
});

Deno.test("parseArgs: open requires an argument", () => {
  assertEquals(parseArgs(["open", "m4mini|~/proj"]).command, {
    cmd: "open",
    arg: "m4mini|~/proj",
  });
  assertEquals(parseArgs(["o", "m4mini|~/proj"]).command, {
    cmd: "open",
    arg: "m4mini|~/proj",
  });
  assertThrows(
    () => parseArgs(["open"]),
    Error,
    "Usage: rproj open 'host|path'",
  );
});

Deno.test("parseArgs: internal preview commands", () => {
  assertEquals(parseArgs(["_preview_multi", "h|p"]).command, {
    cmd: "preview_multi",
    meta: "h|p",
  });
  assertEquals(parseArgs(["_preview", "host", "dir", "item"]).command, {
    cmd: "preview",
    host: "host",
    dir: "dir",
    item: "item",
  });
});

Deno.test("parseArgs: list flags (json and query)", () => {
  assertEquals(parseArgs(["list", "--json"]).command, {
    cmd: "list",
    opts: NO_OPTS,
    json: true,
    query: "",
  });
  assertEquals(parseArgs(["list", "-q", "metron"]).command, {
    cmd: "list",
    opts: NO_OPTS,
    json: false,
    query: "metron",
  });
});

Deno.test("parseArgs: --host flag sets host filter", () => {
  assertEquals(parseArgs(["list", "--host", "m4mini"]).command, {
    cmd: "list",
    opts: { hostFilter: "m4mini", projectName: null },
    json: false,
    query: "",
  });
});

Deno.test("parseArgs: positional and -p both set project name", () => {
  assertEquals(parseArgs(["tmux", "myproj"]).command, {
    cmd: "tmux",
    opts: { hostFilter: null, projectName: "myproj" },
  });
  assertEquals(parseArgs(["tmux", "-p", "myproj"]).command, {
    cmd: "tmux",
    opts: { hostFilter: null, projectName: "myproj" },
  });
});

Deno.test("parseArgs: host-qualified project splits host and name", () => {
  assertEquals(parseArgs(["tmux", "m4mini:personal"]).command, {
    cmd: "tmux",
    opts: { hostFilter: "m4mini", projectName: "personal" },
  });
});

Deno.test("parseArgs: host given by both -h and qualifier conflict throws", () => {
  assertThrows(
    () => parseArgs(["tmux", "-h", "m4mini", "workmbp:personal"]),
    Error,
    "host given twice",
  );
});

Deno.test("parseArgs: --debug alongside a command", () => {
  const result = parseArgs(["list", "--debug"]);
  assertEquals(result.debug, true);
  assertEquals(result.command, {
    cmd: "list",
    opts: NO_OPTS,
    json: false,
    query: "",
  });
});

Deno.test("parseArgs: unknown command throws", () => {
  assertThrows(() => parseArgs(["bogus"]), Error, "Unknown command: bogus");
});

Deno.test("parseArgs: unknown option throws", () => {
  assertThrows(() => parseArgs(["list", "-x"]), Error, "Unknown option: -x");
});

// Documents an existing quirk: a flag-only invocation recurses to
// parseArgs(["default", ...]) and falls through to the unknown-command error
// because the switch has no `case "default"`. Captured so a future fix is a
// deliberate, visible change rather than a silent one.
Deno.test("parseArgs: flag-only default invocation currently throws (known quirk)", () => {
  assertThrows(
    () => parseArgs(["--host", "m4mini"]),
    Error,
    "Unknown command: default",
  );
});
