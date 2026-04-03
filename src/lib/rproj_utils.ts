// rproj_utils.ts — Pure utility functions extracted from rproj for testability.

import { basename } from "jsr:@std/path@1/basename";

// --- Types ---

export interface HostEntry {
  alias: string;
  dir: string;
  label: string;
}

export interface ProjectEntry {
  host: string;
  baseDir: string;
  projectPath: string;
  label: string;
}

export interface ProjectMatch {
  host: string;
  path: string;
}

// --- Shell utilities ---

/**
 * Escape a string for safe use inside single quotes in shell commands.
 * Handles the only dangerous character: single quote itself.
 * 'foo'bar' becomes 'foo'\''bar'
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// --- fzf formatting ---

/**
 * Build fzf-compatible entries from a list of projects.
 * Each line: `host|path\t<display>`
 * Projects are grouped by label with tree-style connectors.
 */
export function buildFzfEntries(projects: ProjectEntry[]): string {
  const lines: string[] = [];
  let currentLabel = "";
  let group: { meta: string; type: "parent" | "child"; name: string }[] = [];

  const flushGroup = (label: string) => {
    if (group.length === 0) return;
    const children = group.filter((g) => g.type === "child");
    let childIdx = 0;
    for (const entry of group) {
      if (entry.type === "parent") {
        lines.push(`${entry.meta}\t\u{1F4C2} ${label}`);
      } else {
        childIdx++;
        const connector = childIdx === children.length ? "\u2514\u2500\u2500" : "\u251C\u2500\u2500";
        lines.push(`${entry.meta}\t   ${connector} ${entry.name}`);
      }
    }
  };

  for (const p of projects) {
    if (p.label !== currentLabel) {
      flushGroup(currentLabel);
      currentLabel = p.label;
      group = [];
    }
    const meta = `${p.host}|${p.projectPath}`;
    if (p.projectPath === p.baseDir) {
      group.push({ meta, type: "parent", name: basename(p.baseDir) });
    } else {
      group.push({ meta, type: "child", name: basename(p.projectPath) });
    }
  }
  flushGroup(currentLabel);

  return lines.join("\n");
}
