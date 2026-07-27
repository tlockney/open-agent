// deploy.ts — the shell script `open-agent setup-remote` runs on a remote.
//
// Kept as a pure string builder so its most important property — that it
// never removes anything — is asserted by tests rather than by reading it.

/** Commands whose wrappers `setup-remote` installs on a remote. */
export const REMOTE_COMMANDS = [
  "ropen",
  "rcode",
  "rcopy",
  "rpaste",
  "rnotify",
  "rop",
  "rpush",
  "rpull",
  "ra",
] as const;

/**
 * Commands that only make sense on a machine running the daemon.
 *
 * `setup-remote` does not deploy these, but it must not remove them either.
 * Every machine here is a peer: each runs its own daemon *and* is a remote for
 * the others, so "this is a remote, therefore it is client-only" is false. An
 * earlier version acted on that assumption and deleted these wrappers along
 * with the whole `src/` tree, which took the daemon's own source with it and
 * left the machine one restart away from a daemon that could not start.
 */
export const HOST_ONLY_COMMANDS = ["rproj", "rtmux", "open-agent"] as const;

/** Where the toolkit lives on a remote. */
const AGENT_DIR = "~/.local/share/open-agent";
const BIN_DIR = "~/.local/bin";

/**
 * Build the deploy script. It is strictly additive: it creates directories,
 * overlays the files it ships, and reports anything that looks left over
 * rather than deleting it.
 *
 * Reads the tarball from stdin, which the caller pipes in.
 */
export function buildDeployScript(
  commands: readonly string[] = REMOTE_COMMANDS,
): string {
  const cmds = commands.join(" ");
  return [
    "set -e",
    "cd $(mktemp -d)",
    "tar xzf -",

    // Overlay the source tree rather than replacing it. `cp -R src/. dest/`
    // copies the *contents*, so files this package ships are refreshed and
    // anything already there — the daemon, the host-only CLIs — is untouched.
    `mkdir -p ${AGENT_DIR}/src ${BIN_DIR}`,
    `cp -R src/. ${AGENT_DIR}/src/`,
    `cp open-agent-hook.sh oa-wrapper.sh ${AGENT_DIR}/`,

    // Install a wrapper per client command.
    `for cmd in ${cmds}; do ` +
    `cp oa-wrapper.sh ${BIN_DIR}/$cmd; ` +
    `chmod +x ${BIN_DIR}/$cmd; ` +
    "done",

    // Report, do not remove. A wrapper whose module is absent will fail with
    // "Module not found" when run, which is worth surfacing — but deciding
    // what to do about it belongs to whoever owns the machine.
    `for cmd in ${HOST_ONLY_COMMANDS.join(" ")}; do ` +
    `if [ -e ${BIN_DIR}/$cmd ] && [ ! -f ${AGENT_DIR}/src/cli/$cmd.ts ]; then ` +
    `echo "oa-warn: ${BIN_DIR}/$cmd has no module in ${AGENT_DIR}/src/cli — ` +
    `left in place; remove it by hand if it is a leftover"; ` +
    "fi; done",

    // A pre-src/ layout put the shared library here. Nothing reads it now,
    // but it is not ours to delete either.
    `if [ -d ${BIN_DIR}/lib ]; then ` +
    `echo "oa-warn: ${BIN_DIR}/lib is from a pre-0.4 layout and is unused ` +
    `— left in place"; ` +
    "fi",

    "true",
  ].join("; ");
}
