import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** realpath of the deepest existing ancestor plus the not-yet-existing tail. */
export function realpathLoose(path: string): string {
  const tail: string[] = []; let cur = path;
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); }
    catch { const parent = dirname(cur); if (parent === cur) return path; tail.push(basename(cur)); cur = parent; }
  }
}
