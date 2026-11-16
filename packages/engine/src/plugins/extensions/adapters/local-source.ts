import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { gitTreeHash } from "../core/files.js";
import { sanitizeName } from "../core/manifest.js";
import { err, ok, type Result } from "../core/result.js";
import type { ExtensionSource, Snapshot } from "../ports.js";
import { readFolder } from "./fs-folder.js";

/** A folder on disk. Unpinned: its revision is `local-<content hash>`, so changed content is a new revision and asks again. */
export class LocalSource implements ExtensionSource {
  readonly pinned = false;
  readonly label: string; readonly suggestedName: string;
  constructor(private readonly path: string) { this.label = path; this.suggestedName = sanitizeName(basename(path)); }
  async fetch(): Promise<Result<Snapshot>> {
    let real: string;
    try { real = realpathSync(this.path); if (!statSync(real).isDirectory()) return err("bad_source", `${this.path} is not a folder.`); } catch { return err("bad_source", `${this.path} does not exist.`); }
    const files = readFolder(real); if (!files.ok) return files;
    const treeHash = gitTreeHash(files.value);
    return ok({ revision: `local-${treeHash.slice(0, 16)}`, files: files.value, treeHash, source: { type: "local", path: real } });
  }
}
