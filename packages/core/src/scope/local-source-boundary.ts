import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";

// An explicit source-folder investigation is a narrower file capability,
// independent of the optional engagement/network authorization plugin.
const boundary = new AsyncLocalStorage<string>();
export function getLocalSourceBoundary(): string | undefined { return boundary.getStore(); }
export function withLocalSourceBoundary<T>(root: string | undefined, run: () => T): T {
  return root === undefined ? run() : boundary.run(realpathSync(root), run);
}
