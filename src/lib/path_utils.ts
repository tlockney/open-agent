// path_utils.ts — Pure path translation for open-agent.

import { normalize } from "jsr:@std/path@1/normalize";

/** Minimal mount info needed for path translation. */
export interface MountInfo {
  remoteHome: string;
  mountPoint: string;
}

/**
 * Translate a remote absolute path to its local SSHFS mount equivalent.
 * Throws if the path is outside the remote home directory.
 */
export function translatePath(remotePath: string, mount: MountInfo): string {
  const normalized = normalize(remotePath);
  const normalizedHome = normalize(mount.remoteHome);
  if (normalized === normalizedHome || normalized.startsWith(normalizedHome + "/")) {
    const relative = normalized.slice(normalizedHome.length);
    return mount.mountPoint + relative;
  }
  throw new Error(
    `Path outside remote home: ${remotePath} (home: ${mount.remoteHome}). ` +
    `Only paths under the remote home directory are accessible via SSHFS.`
  );
}
