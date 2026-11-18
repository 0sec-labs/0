import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

/**
 * Whether `dir` (a canonicalized real path) is a root too dangerous to use as a thread folder: the filesystem
 * root itself (or any drive/mount root, detected as a path that is its own parent) and the user's home directory
 * itself. Subdirectories of home (e.g. `~/code/proj`) are fine.
 */
export function isDangerousLocalRoot(dir: string): boolean {
  if (dirname(dir) === dir) return true;
  try {
    if (dir === realpathSync(homedir())) return true;
  } catch {
    // homedir unresolvable — fall through; the root check above still applies.
  }
  return false;
}
