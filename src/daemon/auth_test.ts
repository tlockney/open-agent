import { assertEquals } from "jsr:@std/assert@1";
import { checkAuth, generateToken, isLoopbackAddress } from "./auth.ts";

Deno.test("generateToken: returns a 64-char lowercase hex string", () => {
  const token = generateToken();
  assertEquals(token.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(token), true);
});

Deno.test("generateToken: two calls differ", () => {
  assertEquals(generateToken() === generateToken(), false);
});

// --- isLoopbackAddress ---

Deno.test("isLoopbackAddress: loopback TCP is local", () => {
  assertEquals(
    isLoopbackAddress({ transport: "tcp", hostname: "127.0.0.1", port: 1 }),
    true,
  );
  assertEquals(
    isLoopbackAddress({ transport: "tcp", hostname: "::1", port: 1 }),
    true,
  );
  assertEquals(
    isLoopbackAddress({ transport: "tcp", hostname: "localhost", port: 1 }),
    true,
  );
});

Deno.test("isLoopbackAddress: non-loopback TCP is not local", () => {
  assertEquals(
    isLoopbackAddress({ transport: "tcp", hostname: "10.0.0.5", port: 1 }),
    false,
  );
  assertEquals(
    isLoopbackAddress({ transport: "tcp", hostname: "192.168.1.10", port: 1 }),
    false,
  );
});

Deno.test("isLoopbackAddress: unix socket and unknown are local", () => {
  assertEquals(
    isLoopbackAddress({ transport: "unix", path: "/tmp/x.sock" }),
    true,
  );
  assertEquals(isLoopbackAddress(undefined), true);
});

// --- checkAuth ---

const TOKEN = "abc123";

Deno.test("checkAuth: loopback needs no token", () => {
  const loopback: Deno.NetAddr = {
    transport: "tcp",
    hostname: "127.0.0.1",
    port: 1,
  };
  assertEquals(checkAuth(loopback, undefined, TOKEN), null);
  assertEquals(checkAuth(loopback, "wrong", TOKEN), null);
});

Deno.test("checkAuth: non-loopback with correct token passes", () => {
  const remote: Deno.NetAddr = {
    transport: "tcp",
    hostname: "10.0.0.5",
    port: 1,
  };
  assertEquals(checkAuth(remote, TOKEN, TOKEN), null);
});

Deno.test("checkAuth: non-loopback with missing or wrong token fails", () => {
  const remote: Deno.NetAddr = {
    transport: "tcp",
    hostname: "10.0.0.5",
    port: 1,
  };
  assertEquals(checkAuth(remote, undefined, TOKEN) !== null, true);
  assertEquals(checkAuth(remote, "wrong", TOKEN) !== null, true);
});
