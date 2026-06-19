// handlers.ts — Per-action message handlers with dependency injection.

import type { ErrorCode, Message } from "../lib/messages.ts";
import { makeError } from "../lib/messages.ts";
import { translatePath } from "../lib/path_utils.ts";
import type { MountManager, MountState } from "./mount_manager.ts";

/** Command result from running an external process. */
export interface CommandResult {
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Spawned process with piped stdin. */
export interface SpawnedProcess {
  stdin: WritableStream<Uint8Array>;
  output(): Promise<{ success: boolean }>;
}

/** System dependencies injected for testability. */
export interface HandlerDeps {
  mountManager: MountManager;
  runCommand(cmd: string, args: string[]): Promise<CommandResult>;
  spawnCommand(cmd: string, opts: { stdin: "piped" }): SpawnedProcess;
  copyFile(src: string, dest: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean }>;
  log(msg: string): void;
  home: string;
  version: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function ok(data?: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data });
}

function err(
  code: ErrorCode,
  message: string,
  opts?: { host?: string; recovery?: string },
): string {
  return JSON.stringify({ ok: false, error: makeError(code, message, opts) });
}

/**
 * Ensure the mount is up AND the requested path exists on it. If the path
 * stat fails, probe the mount root to disambiguate "file genuinely missing"
 * from "mount silently broke between ensureMount and stat". When the mount
 * itself is dead, force a remount and retry once before giving up.
 */
async function verifyMountAndPath(
  deps: HandlerDeps,
  host: string,
  remoteHome: string,
  remotePath: string,
): Promise<
  | { ok: true; localPath: string; state: MountState }
  | { ok: false; code: "path_not_found" | "mount_stale"; message: string }
> {
  let state = await deps.mountManager.ensureMount(host, remoteHome);
  let localPath = translatePath(remotePath, state);

  try {
    await deps.stat(localPath);
    return { ok: true, localPath, state };
  } catch { /* fall through */ }

  // Path stat failed. Probe the mount root to disambiguate.
  let mountAlive = true;
  try {
    await deps.stat(state.mountPoint);
  } catch {
    mountAlive = false;
  }

  if (mountAlive) {
    return {
      ok: false,
      code: "path_not_found",
      message: `path does not exist: ${remotePath}`,
    };
  }

  // Mount silently broke. Force remount and retry once.
  deps.log(`Mount for ${host} died silently; forcing remount`);
  try {
    await deps.mountManager.unmountHost(host);
    state = await deps.mountManager.ensureMount(host, remoteHome);
    localPath = translatePath(remotePath, state);
  } catch (e) {
    return {
      ok: false,
      code: "mount_stale",
      message: `mount for ${host} could not be recovered: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  try {
    await deps.stat(localPath);
    return { ok: true, localPath, state };
  } catch {
    return {
      ok: false,
      code: "path_not_found",
      message: `path does not exist: ${remotePath}`,
    };
  }
}

// --- Handlers ---

export async function handleConnect(
  msg: Extract<Message, { action: "connect" }>,
  deps: HandlerDeps,
): Promise<string> {
  const state = await deps.mountManager.ensureMount(msg.host, msg.remoteHome);
  state.sessions.add(msg.sessionId);
  deps.log(
    `Session ${msg.sessionId}@${msg.host} connected (${state.sessions.size} active)`,
  );
  return ok({ mountPoint: state.mountPoint });
}

export function handleDisconnect(
  msg: Extract<Message, { action: "disconnect" }>,
  deps: HandlerDeps,
): string {
  const state = deps.mountManager.getMount(msg.host);
  if (state) {
    state.sessions.delete(msg.sessionId);
    deps.log(
      `Session ${msg.sessionId}@${msg.host} disconnected (${state.sessions.size} remaining)`,
    );
    if (state.sessions.size === 0) {
      deps.mountManager.scheduleUnmount(msg.host);
    }
  }
  return ok();
}

export async function handleOpen(
  msg: Extract<Message, { action: "open" }>,
  deps: HandlerDeps,
): Promise<string> {
  const verified = await verifyMountAndPath(
    deps,
    msg.host,
    msg.remoteHome,
    msg.path,
  );
  if (!verified.ok) {
    const opts: { host: string; recovery?: string } = { host: msg.host };
    if (verified.code === "mount_stale") opts.recovery = `ra reset ${msg.host}`;
    return err(verified.code, verified.message, opts);
  }
  const { localPath } = verified;

  const args: string[] = [];
  if (msg.app) args.push("-a", msg.app);
  args.push(localPath);

  deps.log(`open ${args.join(" ")}`);
  const result = await deps.runCommand("open", args);

  if (!result.success) {
    return err("internal", `open failed: ${decoder.decode(result.stderr)}`);
  }
  return ok({ localPath });
}

export async function handleOpenVscode(
  msg: Extract<Message, { action: "open-vscode" }>,
  deps: HandlerDeps,
): Promise<string> {
  const args = ["--remote", `ssh-remote+${msg.host}`, msg.path];
  deps.log(`code ${args.join(" ")}`);
  const result = await deps.runCommand("code", args);

  if (!result.success) {
    return err("internal", `code failed: ${decoder.decode(result.stderr)}`);
  }
  return ok();
}

export async function handleCopy(
  msg: Extract<Message, { action: "copy" }>,
  deps: HandlerDeps,
): Promise<string> {
  const proc = deps.spawnCommand("pbcopy", { stdin: "piped" });
  const writer = proc.stdin.getWriter();
  await writer.write(encoder.encode(msg.content));
  await writer.close();
  const { success } = await proc.output();
  if (!success) {
    return err("internal", "pbcopy failed");
  }
  deps.log(`Copied ${msg.content.length} bytes to clipboard`);
  return ok({ bytes: msg.content.length });
}

export async function handlePaste(
  deps: HandlerDeps,
): Promise<string> {
  const result = await deps.runCommand("pbpaste", []);
  if (!result.success) {
    return err("internal", "pbpaste failed");
  }
  const content = decoder.decode(result.stdout);
  return ok({ content });
}

export async function handleNotify(
  msg: Extract<Message, { action: "notify" }>,
  deps: HandlerDeps,
): Promise<string> {
  const args = ["-title", msg.title];
  if (msg.message) args.push("-message", msg.message);
  if (msg.subtitle) args.push("-subtitle", msg.subtitle);
  if (msg.sound) args.push("-sound", msg.sound);

  const result = await deps.runCommand("terminal-notifier", args);
  if (!result.success) {
    return err(
      "internal",
      `notification failed: ${decoder.decode(result.stderr)}`,
    );
  }
  deps.log(`Notification: ${msg.title}`);
  return ok();
}

export function handleOpenUrl(
  msg: Extract<Message, { action: "open-url" }>,
  deps: HandlerDeps,
): Promise<string> {
  if (!/^https?:\/\//i.test(msg.url)) {
    return Promise.resolve(
      err("internal", "Only http/https URLs are supported"),
    );
  }
  deps.log(`Opening URL: ${msg.url}`);
  return deps.runCommand("open", [msg.url]).then((result) => {
    if (!result.success) {
      return err(
        "internal",
        `open URL failed: ${decoder.decode(result.stderr)}`,
      );
    }
    return ok();
  });
}

export async function handlePush(
  msg: Extract<Message, { action: "push" }>,
  deps: HandlerDeps,
): Promise<string> {
  const verified = await verifyMountAndPath(
    deps,
    msg.host,
    msg.remoteHome,
    msg.path,
  );
  if (!verified.ok) {
    const opts: { host: string; recovery?: string } = { host: msg.host };
    if (verified.code === "mount_stale") opts.recovery = `ra reset ${msg.host}`;
    return err(verified.code, verified.message, opts);
  }
  const srcPath = verified.localPath;
  const dest = msg.dest ?? `${deps.home}/Downloads`;
  const fileName = srcPath.split("/").pop()!;
  const destPath = `${dest}/${fileName}`;

  deps.log(`Push: ${srcPath} → ${destPath}`);
  await deps.copyFile(srcPath, destPath);
  return ok({ localPath: destPath });
}

export async function handlePull(
  msg: Extract<Message, { action: "pull" }>,
  deps: HandlerDeps,
): Promise<string> {
  const state = await deps.mountManager.ensureMount(msg.host, msg.remoteHome);
  const destMountPath = translatePath(msg.remoteDest, state);
  const fileName = msg.localPath.split("/").pop()!;

  let finalDest = destMountPath;
  try {
    const stat = await deps.stat(destMountPath);
    if (stat.isDirectory) {
      finalDest = `${destMountPath}/${fileName}`;
    }
  } catch {
    // Destination doesn't exist on mount — treat as full file path
  }

  deps.log(`Pull: ${msg.localPath} → ${finalDest}`);
  await deps.copyFile(msg.localPath, finalDest);
  return ok({
    remotePath: msg.remoteDest.endsWith("/")
      ? `${msg.remoteDest}${fileName}`
      : msg.remoteDest,
  });
}

export async function handleOpRead(
  msg: Extract<Message, { action: "op-read" }>,
  deps: HandlerDeps,
): Promise<string> {
  deps.log(`op-read: resolving reference`);
  const opArgs = [
    ...(msg.account ? ["--account", msg.account] : []),
    "read",
    msg.ref,
  ];
  const result = await deps.runCommand("op", opArgs);
  if (!result.success) {
    return err(
      "internal",
      `op read failed: ${decoder.decode(result.stderr).trim()}`,
    );
  }
  const value = decoder.decode(result.stdout).trim();
  return ok({ value });
}

export async function handleOpResolve(
  msg: Extract<Message, { action: "op-resolve" }>,
  deps: HandlerDeps,
): Promise<string> {
  deps.log(`op-resolve: resolving ${Object.keys(msg.refs).length} references`);
  const resolved: Record<string, string> = {};
  const errors: string[] = [];

  const entries = Object.entries(msg.refs);
  const accountArgs = msg.account ? ["--account", msg.account] : [];
  const results = await Promise.all(
    entries.map(async ([key, ref]) => {
      const result = await deps.runCommand("op", [...accountArgs, "read", ref]);
      if (!result.success) {
        return { key, error: decoder.decode(result.stderr).trim() };
      }
      return { key, value: decoder.decode(result.stdout).trim() };
    }),
  );

  for (const r of results) {
    if ("error" in r) {
      errors.push(`${r.key}: ${r.error}`);
    } else {
      resolved[r.key] = r.value;
    }
  }

  if (errors.length > 0) {
    return err("internal", `Failed to resolve: ${errors.join("; ")}`);
  }
  return ok({ resolved });
}

/**
 * Lightweight liveness probe — no mount checks, no external commands.
 * Used by `ra ping` and CLI pre-flight to distinguish "agent down" from
 * "agent up but slow on a real request".
 */
export function handlePing(deps: HandlerDeps): string {
  return ok({ pong: true, version: deps.version });
}

/**
 * Per-mount diagnostic probe — actively checks whether each mount is
 * responsive (via stat with timeout). Backs `ra doctor` so the user
 * can see at a glance which mounts are healthy vs. broken.
 */
export async function handleDoctor(deps: HandlerDeps): Promise<string> {
  const mounts: Record<string, {
    mountPoint: string;
    remoteHome: string;
    responsive: boolean;
    activeSessions: number;
    pendingUnmount: boolean;
  }> = {};
  for (const [host, state] of deps.mountManager.getAllMounts()) {
    const responsive = await deps.mountManager.isMountResponsive(
      state.mountPoint,
    );
    mounts[host] = {
      mountPoint: state.mountPoint,
      remoteHome: state.remoteHome,
      responsive,
      activeSessions: state.sessions.size,
      pendingUnmount: state.unmountTimer !== undefined,
    };
  }
  return ok({ version: deps.version, mounts });
}

/**
 * Tear down mount(s) and purge their in-memory session state. Used by
 * `ra reset` to recover from a stale mount when the daemon's automatic
 * remount-on-demand can't get it back to a working state.
 */
export async function handleReset(
  msg: Extract<Message, { action: "reset" }>,
  deps: HandlerDeps,
): Promise<string> {
  const targets = msg.host
    ? [msg.host]
    : [...deps.mountManager.getAllMounts().keys()];
  const reset: string[] = [];
  for (const host of targets) {
    if (deps.mountManager.getMount(host)) {
      await deps.mountManager.unmountHost(host);
      reset.push(host);
    }
  }
  deps.log(
    `Reset: ${reset.length === 0 ? "(no mounts to reset)" : reset.join(", ")}`,
  );
  return ok({ reset });
}

export function handleStatus(deps: HandlerDeps): string {
  const status = Object.fromEntries(
    [...deps.mountManager.getAllMounts().entries()].map(([host, state]) => [
      host,
      {
        mountPoint: state.mountPoint,
        remoteHome: state.remoteHome,
        activeSessions: state.sessions.size,
        sessions: [...state.sessions],
        pendingUnmount: state.unmountTimer !== undefined,
      },
    ]),
  );
  return ok({ version: deps.version, mounts: status });
}

// --- Dispatcher ---

export async function handleMessage(
  msg: Message,
  deps: HandlerDeps,
): Promise<string> {
  switch (msg.action) {
    case "connect":
      return handleConnect(msg, deps);
    case "disconnect":
      return handleDisconnect(msg, deps);
    case "open":
      return handleOpen(msg, deps);
    case "open-vscode":
      return handleOpenVscode(msg, deps);
    case "copy":
      return handleCopy(msg, deps);
    case "paste":
      return handlePaste(deps);
    case "notify":
      return handleNotify(msg, deps);
    case "open-url":
      return handleOpenUrl(msg, deps);
    case "push":
      return handlePush(msg, deps);
    case "pull":
      return handlePull(msg, deps);
    case "op-read":
      return handleOpRead(msg, deps);
    case "op-resolve":
      return handleOpResolve(msg, deps);
    case "status":
      return handleStatus(deps);
    case "ping":
      return handlePing(deps);
    case "reset":
      return handleReset(msg, deps);
    case "doctor":
      return handleDoctor(deps);
  }
}
