import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Mount the running distribution, rather than trusting an older image's bundled CLI. */
export function currentWorkbenchAssets(moduleUrl: string = import.meta.url): { cliDist: string } {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 5; depth++) {
    for (const candidate of [directory, join(directory, "dist")]) {
      const entry = join(candidate, "0.js");
      if (existsSync(entry) && lstatSync(entry).isFile() && !lstatSync(entry).isSymbolicLink()) return { cliDist: realpathSync(candidate) };
    }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  throw new Error("Current workbench CLI distribution is unavailable. Build/install the current CLI bundle before isolated execution; an older image CLI is not used.");
}
