import { gitTreeHash, type FolderFile } from "./core/files.js";
import { err, ok, type Result } from "./core/result.js";
import type { ExtensionEntry } from "./core/state.js";
import type { ExtensionStore } from "./ports.js";

/**
 * Read an installed revision and check it still hashes to its pin. Content that differs from what was approved
 * (edited, truncated, swapped, or holding a planted `.git`) is `tampered` and must not be loaded. This holds for
 * stored revisions AND for folders adopted in place by the importer: both are pinned to their tree hash.
 */
export function readVerified(store: ExtensionStore, entry: ExtensionEntry, revision: string): Result<FolderFile[]> {
  const record = entry.revisions[revision];
  if (!record) return err("missing", `${entry.name} has no revision ${revision.slice(0, 12)}.`);
  const files = store.readRevision(entry.name, revision, record.location);
  if (!files.ok) return files;
  if (gitTreeHash(files.value) !== record.treeHash) {
    return err("tampered", `${entry.name}: folder content differs from the pinned revision ${revision.slice(0, 12)}; refusing to load it. Reinstall it.`);
  }
  return ok(files.value);
}
