/**
 * Skills that enabled extensions provide. Skill discovery asks this module for folders; it never reads a folder
 * that `loadable()` refused (tampered, capabilities changed, not approved, unmigrated) or one that is disabled.
 */
import { join } from "node:path";
import { FsExtensionStore } from "./adapters/fs-store.js";
import { projectKeyOf } from "./project-key.js";
import { loadable } from "./runtime.js";

export interface ExtensionSkillRoot { extension: string; revision: string; /** Absolute folder that contains one SKILL.md. */ folder: string }

/** Absolute skill folders of every extension that may run for `project` (null: global enablement only). */
export function extensionSkillRoots(options: { home?: string; project?: string | null } = {}): ExtensionSkillRoot[] {
  try {
    const result = loadable(new FsExtensionStore(options.home), options.project ? projectKeyOf(options.project) : null);
    return result.extensions.flatMap(ext => ext.manifest.skills.map(skill => ({ extension: ext.name, revision: ext.revision, folder: skill.path === "." ? ext.dir : join(ext.dir, skill.path) })));
  } catch { return []; }
}
