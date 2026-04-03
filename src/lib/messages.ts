// messages.ts — Shared message types and validation for open-agent protocol.
//
// Used by both the daemon (server) and CLI scripts (clients).

// --- Message types ---

export type Message =
  | { action: "open"; host: string; remoteHome: string; path: string; app?: string }
  | { action: "open-vscode"; host: string; path: string }
  | { action: "connect"; host: string; remoteHome: string; sessionId: string }
  | { action: "disconnect"; host: string; sessionId: string }
  | { action: "copy"; content: string }
  | { action: "paste" }
  | { action: "notify"; title: string; message?: string; subtitle?: string; sound?: string }
  | { action: "open-url"; url: string }
  | { action: "push"; host: string; remoteHome: string; path: string; dest?: string }
  | { action: "pull"; host: string; remoteHome: string; localPath: string; remoteDest: string }
  | { action: "op-read"; ref: string; account?: string }
  | { action: "op-resolve"; refs: Record<string, string>; account?: string }
  | { action: "status" };

// --- Response types ---

export interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type Response = OkResponse | ErrorResponse;

// --- Validation ---

export function parseMessage(raw: unknown): Message {
  if (typeof raw !== "object" || raw === null || !("action" in raw)) {
    throw new Error("Missing 'action' field");
  }
  const obj = raw as Record<string, unknown>;
  const action = obj.action;

  const requireStrings = (fields: string[]) => {
    for (const f of fields) {
      if (typeof obj[f] !== "string") throw new Error(`Missing or invalid '${f}'`);
    }
  };

  switch (action) {
    case "open":
      requireStrings(["host", "remoteHome", "path"]);
      if (obj.app !== undefined && typeof obj.app !== "string") {
        throw new Error("Invalid 'app' field");
      }
      break;
    case "open-vscode":
      requireStrings(["host", "path"]);
      break;
    case "connect":
      requireStrings(["host", "remoteHome", "sessionId"]);
      break;
    case "disconnect":
      requireStrings(["host", "sessionId"]);
      break;
    case "copy":
      requireStrings(["content"]);
      break;
    case "paste":
      break;
    case "notify":
      requireStrings(["title"]);
      if (obj.message !== undefined && typeof obj.message !== "string") {
        throw new Error("Invalid 'message' field");
      }
      if (obj.subtitle !== undefined && typeof obj.subtitle !== "string") {
        throw new Error("Invalid 'subtitle' field");
      }
      if (obj.sound !== undefined && typeof obj.sound !== "string") {
        throw new Error("Invalid 'sound' field");
      }
      break;
    case "open-url":
      requireStrings(["url"]);
      break;
    case "push":
      requireStrings(["host", "remoteHome", "path"]);
      if (obj.dest !== undefined && typeof obj.dest !== "string") {
        throw new Error("Invalid 'dest' field");
      }
      break;
    case "pull":
      requireStrings(["host", "remoteHome", "localPath", "remoteDest"]);
      break;
    case "op-read":
      requireStrings(["ref"]);
      if (!/^op:\/\//.test(obj.ref as string)) {
        throw new Error("ref must be an op:// reference");
      }
      if (obj.account !== undefined && typeof obj.account !== "string") {
        throw new Error("Invalid 'account' field");
      }
      break;
    case "op-resolve": {
      if (typeof obj.refs !== "object" || obj.refs === null || Array.isArray(obj.refs)) {
        throw new Error("Missing or invalid 'refs' (expected object)");
      }
      const refs = obj.refs as Record<string, unknown>;
      for (const [key, val] of Object.entries(refs)) {
        if (typeof val !== "string") throw new Error(`Invalid ref value for '${key}'`);
        if (!/^op:\/\//.test(val)) throw new Error(`'${key}' is not an op:// reference: ${val}`);
      }
      if (obj.account !== undefined && typeof obj.account !== "string") {
        throw new Error("Invalid 'account' field");
      }
      break;
    }
    case "status":
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  return raw as Message;
}
