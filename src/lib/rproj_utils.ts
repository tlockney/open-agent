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

// --- Terminal restore ---

/**
 * Bytes that undo the terminal-side state changes a remote tmux session
 * normally tears down on a clean exit but cannot when the SSH connection
 * dies abruptly. Sending these locally is what stops the terminal from
 * being stuck in alt-screen / mouse-tracking / paste mode and prevents
 * the post-disconnect flood of decoded mouse events appearing as text.
 *
 * Two axes of mouse state exist in xterm-style terminals (and we have to
 * clear both independently — they latch separately even though setting
 * a newer tracking mode typically replaces the older ones):
 *
 *   tracking (whether events are emitted):
 *     ?9    X10 compat            ?1001  highlight tracking
 *     ?1000 VT200 button-event    ?1002  cell-motion
 *     ?1003 all-motion
 *
 *   encoding (how events are framed on the wire):
 *     ?1005 UTF-8     ?1006 SGR     ?1015 URxvt     ?1016 SGR-pixels
 *
 * The URxvt encoding (?1015) is what's been leaking through here:
 * tmux negotiates it on some xterm-* / tmux-256color terminfo entries,
 * and a too-narrow cleanup leaves the terminal still emitting
 * `CSI Cb;Cx;Cy M` events that the user's shell then echoes as text.
 */
export const TERMINAL_RESTORE_SEQUENCE =
  "\x1b[?1049l" +   // leave alternate screen buffer
  "\x1b[?9l" +      // X10 mouse tracking off (legacy)
  "\x1b[?1000l" +   // VT200 button-event mouse off
  "\x1b[?1001l" +   // highlight mouse tracking off
  "\x1b[?1002l" +   // cell-motion mouse tracking off
  "\x1b[?1003l" +   // all-motion mouse tracking off
  "\x1b[?1004l" +   // focus event reporting off
  "\x1b[?1005l" +   // UTF-8 mouse encoding off
  "\x1b[?1006l" +   // SGR mouse encoding off
  "\x1b[?1015l" +   // URxvt mouse encoding off
  "\x1b[?1016l" +   // SGR-Pixels mouse encoding off
  "\x1b[?2004l" +   // bracketed paste mode off
  "\x1b[?25h" +     // show cursor
  "\x1b(B";         // designate G0 to ASCII

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
