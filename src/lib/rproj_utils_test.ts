import { assertEquals } from "jsr:@std/assert";
import { shellQuote, buildFzfEntries, type ProjectEntry } from "./rproj_utils.ts";

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
    { host: "h1", baseDir: "/src/projects", projectPath: "/src/projects", label: "Work" },
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
    { host: "h2", baseDir: "/home/dev", projectPath: "/home/dev", label: "Personal" },
    { host: "h2", baseDir: "/home/dev", projectPath: "/home/dev/blog", label: "Personal" },
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
