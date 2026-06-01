# SSH-aware Local Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an `r*` command runs outside an SSH session, transparently exec the native local tool instead of contacting the open-agent daemon.

**Architecture:** Add one shared detection helper, `isRemoteSession()`, to `src/lib/oa.ts`. Each affected command (`ropen`, `rcopy`, `rpaste`, `rop`) calls it early and, when not remote, execs the local equivalent (`open` / `pbcopy` / `pbpaste` / `op`) and exits with that process's code. The existing `rcode` command is retrofitted to use the same helper so detection has a single source of truth.

**Tech Stack:** Deno + TypeScript. Tests use `Deno.test` with `jsr:@std/assert`. Run tests with `deno task test` (`deno test --allow-read --allow-env`) and type-check with `deno task check`.

---

## File Structure

- **Modify** `src/lib/oa.ts` — add the `isRemoteSession()` helper alongside the other shared exports.
- **Modify** `src/lib/oa_test.ts` — add unit tests for `isRemoteSession()`.
- **Modify** `src/cli/rcode.ts` — replace its inline `SSH_CONNECTION` check with `isRemoteSession()`.
- **Modify** `src/cli/ropen.ts` — add local `open`/`code` fallback branch.
- **Modify** `src/cli/rcopy.ts` — add local `pbcopy` fallback branch.
- **Modify** `src/cli/rpaste.ts` — add local `pbpaste` fallback branch.
- **Modify** `src/cli/rop.ts` — add local `op` delegation branch.

No new files. The shell hook (`open-agent-hook.sh`) is intentionally left unchanged.

---

## Task 1: `isRemoteSession()` helper (TDD)

**Files:**
- Modify: `src/lib/oa.ts` (add export near the other top-level exports, around line 26)
- Test: `src/lib/oa_test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the end of `src/lib/oa_test.ts`. Also add `isRemoteSession` to the existing import from `./oa.ts` so the line reads:

```ts
import { formatErrorMessage, getStringField, isRemoteSession } from "./oa.ts";
```

Then append:

```ts
// --- isRemoteSession ---

const SSH_VARS = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"] as const;

// Save the three SSH vars, clear them, run body, then restore. Keeps the
// real test environment (which may itself be an SSH session) from leaking
// into these assertions.
function withSshEnv(set: Partial<Record<typeof SSH_VARS[number], string>>, body: () => void): void {
  const saved = SSH_VARS.map((v) => [v, Deno.env.get(v)] as const);
  for (const v of SSH_VARS) Deno.env.delete(v);
  for (const [k, val] of Object.entries(set)) Deno.env.set(k, val);
  try {
    body();
  } finally {
    for (const [v, val] of saved) {
      if (val === undefined) Deno.env.delete(v);
      else Deno.env.set(v, val);
    }
  }
}

Deno.test("isRemoteSession: false when no SSH vars set", () => {
  withSshEnv({}, () => assertEquals(isRemoteSession(), false));
});

Deno.test("isRemoteSession: true when SSH_CONNECTION set", () => {
  withSshEnv({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }, () =>
    assertEquals(isRemoteSession(), true));
});

Deno.test("isRemoteSession: true when SSH_TTY set", () => {
  withSshEnv({ SSH_TTY: "/dev/ttys001" }, () =>
    assertEquals(isRemoteSession(), true));
});

Deno.test("isRemoteSession: true when SSH_CLIENT set", () => {
  withSshEnv({ SSH_CLIENT: "1.2.3.4 22 22" }, () =>
    assertEquals(isRemoteSession(), true));
});

Deno.test("isRemoteSession: true when several SSH vars set", () => {
  withSshEnv({ SSH_CONNECTION: "x", SSH_TTY: "y" }, () =>
    assertEquals(isRemoteSession(), true));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test`
Expected: FAIL — compile/type error because `isRemoteSession` is not exported from `./oa.ts`.

- [ ] **Step 3: Implement the helper**

In `src/lib/oa.ts`, after the `export const HOST = resolveHost();` line (around line 26), add:

```ts
/**
 * True when running inside an SSH session — i.e. on the remote machine,
 * where the r* commands should reach back to the local agent. False means
 * we're sitting at the local Mac and should run the native equivalent.
 */
export function isRemoteSession(): boolean {
  return Boolean(
    Deno.env.get("SSH_CONNECTION") ||
      Deno.env.get("SSH_TTY") ||
      Deno.env.get("SSH_CLIENT"),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test`
Expected: PASS — all `isRemoteSession` tests green, existing tests still green.

- [ ] **Step 5: Type-check**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/oa.ts src/lib/oa_test.ts
git commit -m "feat: add isRemoteSession helper for SSH detection"
```

---

## Task 2: Retrofit `rcode` to use the helper

**Files:**
- Modify: `src/cli/rcode.ts:7-13`

No new test: this is a thin dispatch with no business logic, and the helper it now calls is already covered by Task 1. The existing `rcode` branches have never been unit-tested.

- [ ] **Step 1: Add the import**

In `src/cli/rcode.ts`, after the existing path imports (lines 7-8), add a third import line:

```ts
import { isRemoteSession } from "../lib/oa.ts";
```

- [ ] **Step 2: Swap the condition**

Replace this line (line 13):

```ts
if (Deno.env.get("SSH_CONNECTION")) {
```

with:

```ts
if (isRemoteSession()) {
```

- [ ] **Step 3: Type-check**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 4: Verify the local branch still dispatches**

Run (forces non-SSH, asks rproj for help so nothing is actually opened):

```bash
env -u SSH_CONNECTION -u SSH_TTY -u SSH_CLIENT \
  deno run --allow-read --allow-write --allow-run --allow-env \
  src/cli/rcode.ts --help 2>&1 | head -5
```

Expected: output comes from `rproj code` (the local delegate), not an agent error.

- [ ] **Step 5: Commit**

```bash
git add src/cli/rcode.ts
git commit -m "refactor: use isRemoteSession in rcode for single detection rule"
```

---

## Task 3: `ropen` local fallback → `open` / `code`

**Files:**
- Modify: `src/cli/ropen.ts:10` (import) and after the path-resolution block (around line 56, before the "Build message" comment at line 64)

No new unit test: the branch is side-effecting glue that spawns `open`/`code`. Verified by type-check plus the manual smoke test below.

- [ ] **Step 1: Add `isRemoteSession` to the import**

Replace the import on line 10:

```ts
import { fail, formatErrorMessage, HOME, HOST, send } from "../lib/oa.ts";
```

with:

```ts
import { fail, formatErrorMessage, HOME, HOST, isRemoteSession, send } from "../lib/oa.ts";
```

- [ ] **Step 2: Insert the local-fallback branch**

After the path-resolution block that ends at line 56 (the closing `}` of `if (!isUrl) { ... }`) and before the `// Detect VS Code by app name` comment, insert:

```ts
// Not in an SSH session — we're on the local Mac, so the agent round-trip
// is pointless and `target` is already a real local path. Run native open
// (or VS Code) directly. Note: this only triggers when we were never
// remote; the agent-unreachable-while-remote case below still errors loudly.
if (!isRemoteSession()) {
  let cmdArgs: string[];
  if (isUrl) {
    cmdArgs = ["open", target];
  } else if (vscode || app.includes("Visual Studio Code") || (app.includes("Code") && !app.includes("Xcode"))) {
    cmdArgs = ["code", target];
  } else if (app) {
    cmdArgs = ["open", "-a", app, target];
  } else {
    cmdArgs = ["open", target];
  }
  const { code } = await new Deno.Command(cmdArgs[0], {
    args: cmdArgs.slice(1),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}
```

- [ ] **Step 3: Type-check**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 4: Manual smoke test (optional — actually opens a file)**

```bash
env -u SSH_CONNECTION -u SSH_TTY -u SSH_CLIENT \
  deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876 \
  src/cli/ropen.ts README.md
```

Expected: `README.md` opens in the local default app; no "agent unreachable" error.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ropen.ts
git commit -m "feat: ropen falls back to native open/code outside SSH"
```

---

## Task 4: `rcopy` local fallback → `pbcopy`

**Files:**
- Modify: `src/cli/rcopy.ts` (full rewrite of the small body — shown below)

No new unit test: side-effecting glue that spawns `pbcopy`. Verified by type-check and the manual smoke test in Task 7.

- [ ] **Step 1: Rewrite the command body**

Replace the entire contents of `src/cli/rcopy.ts` below the shebang/comment header (lines 6 onward) so the file reads:

```ts
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// rcopy - copy stdin to the local machine's clipboard via open-agent
// Usage: echo "text" | rcopy
//        cat file.txt | rcopy

import { checkResponse, fail, isRemoteSession, requireSock, send } from "../lib/oa.ts";

const input = await new Response(Deno.stdin.readable).text();
if (!input) fail("no input on stdin");

if (!isRemoteSession()) {
  // Local Mac — copy straight to the system clipboard.
  const proc = new Deno.Command("pbcopy", { stdin: "piped" }).spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code } = await proc.status;
  Deno.exit(code);
}

requireSock();

const response = await send({ action: "copy", content: input });
checkResponse(response);
```

Note: the shebang gains `--allow-run` (for `pbcopy`) so the file behaves the same when executed directly; the production wrapper already grants it.

- [ ] **Step 2: Type-check**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/rcopy.ts
git commit -m "feat: rcopy falls back to pbcopy outside SSH"
```

---

## Task 5: `rpaste` local fallback → `pbpaste`

**Files:**
- Modify: `src/cli/rpaste.ts` (full rewrite of the small body — shown below)

No new unit test: side-effecting glue that spawns `pbpaste`. Verified by type-check and the manual smoke test in Task 7.

- [ ] **Step 1: Rewrite the command body**

Replace the entire contents of `src/cli/rpaste.ts` so the file reads:

```ts
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876
// rpaste - paste from the local machine's clipboard via open-agent
// Usage: rpaste
//        rpaste | vim -

import { checkResponse, getStringField, isRemoteSession, requireSock, send } from "../lib/oa.ts";

if (!isRemoteSession()) {
  // Local Mac — read the system clipboard directly.
  const { code } = await new Deno.Command("pbpaste", {
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}

requireSock();

const response = await send({ action: "paste" });
checkResponse(response);

const content = getStringField(response, "content");
if (content) await Deno.stdout.write(new TextEncoder().encode(content));
```

Note: the shebang gains `--allow-run` (for `pbpaste`); the production wrapper already grants it.

- [ ] **Step 2: Type-check**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/rpaste.ts
git commit -m "feat: rpaste falls back to pbpaste outside SSH"
```

---

## Task 6: `rop` local fallback → native `op`

**Files:**
- Modify: `src/cli/rop.ts:8` (import) and `src/cli/rop.ts:43-47` (subcommand + help handling)

No new unit test: side-effecting glue that execs `op`. Verified by type-check and the help-path smoke test below.

- [ ] **Step 1: Add `isRemoteSession` to the import**

Replace the import on line 8:

```ts
import { send, requireSock, checkResponse, getStringField, fail } from "../lib/oa.ts";
```

with:

```ts
import { send, requireSock, checkResponse, getStringField, fail, isRemoteSession } from "../lib/oa.ts";
```

- [ ] **Step 2: Add an `isHelp` const and the local-delegation branch**

Replace this block (lines 43-48):

```ts
const subcmd = filtered[0];

if (subcmd !== "-h" && subcmd !== "--help" && subcmd !== "help") {
  requireSock();
}
const rest = filtered.slice(1);
```

with:

```ts
const subcmd = filtered[0];
const isHelp = subcmd === "-h" || subcmd === "--help" || subcmd === "help";

if (!isHelp && !isRemoteSession()) {
  // Local Mac — the real `op` CLI is available, so delegate verbatim. op
  // does its own op:// resolution; --account passes straight through.
  // Help still falls through to rop's own USAGE below.
  const { code } = await new Deno.Command("op", {
    args: Deno.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}

if (!isHelp) {
  requireSock();
}
const rest = filtered.slice(1);
```

- [ ] **Step 3: Type-check**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 4: Verify the help path still shows rop's usage**

```bash
env -u SSH_CONNECTION -u SSH_TTY -u SSH_CLIENT \
  deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876 \
  src/cli/rop.ts --help 2>&1 | head -3
```

Expected: rop's own `Usage: rop [--account <account>] ...` text (not `op`'s help), confirming help is not delegated.

- [ ] **Step 5: Commit**

```bash
git add src/cli/rop.ts
git commit -m "feat: rop delegates to native op outside SSH"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `deno task test`
Expected: all tests pass, including the `isRemoteSession` tests from Task 1.

- [ ] **Step 2: Type-check the whole project**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 3: Deterministic clipboard round-trip smoke test**

```bash
# Put a known value on the local clipboard via rcopy's local fallback...
printf 'oa-fallback-check' | env -u SSH_CONNECTION -u SSH_TTY -u SSH_CLIENT \
  deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876 \
  src/cli/rcopy.ts

# ...then read it back via rpaste's local fallback.
env -u SSH_CONNECTION -u SSH_TTY -u SSH_CLIENT \
  deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876 \
  src/cli/rpaste.ts
```

Expected: the second command prints `oa-fallback-check`, proving `rcopy`→`pbcopy` and `rpaste`→`pbpaste` both work with no daemon running.

- [ ] **Step 4: Confirm remote behavior is unchanged (no daemon needed)**

```bash
# With an SSH var present, rpaste should attempt the agent path and fail to
# connect (NOT shell out to pbpaste) — confirming the gate flips correctly.
SSH_CONNECTION="1.2.3.4 22 5.6.7.8 22" \
  deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:19876 \
  src/cli/rpaste.ts 2>&1 | head -3
```

Expected: a "failed to connect to agent" style error (because no daemon/tunnel is present in this test), confirming the remote path is taken when SSH vars are set.

- [ ] **Step 5: Final commit (if any verification-driven fixes were made)**

```bash
git add -A
git commit -m "test: verify SSH-aware local fallback end to end"
```

(Skip if Steps 1-4 required no changes.)
