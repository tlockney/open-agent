import { assertEquals, assertThrows } from "jsr:@std/assert";
import { translatePath } from "./path_utils.ts";

const mount = { remoteHome: "/home/user", mountPoint: "/mnt/host" };

Deno.test("translatePath: file in home directory", () => {
  assertEquals(
    translatePath("/home/user/project/file.ts", mount),
    "/mnt/host/project/file.ts",
  );
});

Deno.test("translatePath: nested path", () => {
  assertEquals(
    translatePath("/home/user/a/b/c/d.txt", mount),
    "/mnt/host/a/b/c/d.txt",
  );
});

Deno.test("translatePath: home directory itself", () => {
  assertEquals(translatePath("/home/user", mount), "/mnt/host");
});

Deno.test("translatePath: home with trailing slash normalizes", () => {
  assertEquals(translatePath("/home/user/", mount), "/mnt/host/");
});

Deno.test("translatePath: path with .. segments", () => {
  assertEquals(
    translatePath("/home/user/a/../b/file.ts", mount),
    "/mnt/host/b/file.ts",
  );
});

Deno.test("translatePath: path outside home throws", () => {
  assertThrows(
    () => translatePath("/etc/passwd", mount),
    Error,
    "Path outside remote home",
  );
});

Deno.test("translatePath: path that is prefix of home but not under it", () => {
  // /home/username starts with /home/user but is not under /home/user/
  assertThrows(
    () => translatePath("/home/username/file.ts", mount),
    Error,
    "Path outside remote home",
  );
});

Deno.test("translatePath: path traversing above home", () => {
  assertThrows(
    () => translatePath("/home/user/../../etc/passwd", mount),
    Error,
    "Path outside remote home",
  );
});

// Note: root-level remoteHome ("/") is not a realistic case -- SSHFS always
// mounts from a user's home directory. The path check logic doesn't handle
// it, and that's fine.
