/**
 * File-system ExtensionStore under `~/.0/extensions/`:
 *   state.json                       approvals, enablement, import report (0600)
 *   audit.jsonl                      install/update/enable/disable/remove events (0600)
 *   <name>/<revision>/...            immutable files per revision (0700)
 * The root is derived from the state-dir helper, so HOME is redirectable in tests.
 */
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homeStateDir } from "../../../shared/index.js";
import { gitTreeHash, type FolderFile } from "../core/files.js";
import { err, ok, type Result } from "../core/result.js";
import { emptyState, parseState, type ExtensionState, type RevisionRecord } from "../core/state.js";
import type { AuditEvent, Clock, ExtensionStore } from "../ports.js";
import { readFolder, writeFolder } from "./fs-folder.js";

export const extensionsRoot = (home?: string): string => join(homeStateDir(home), "extensions");
const SAFE = /^[a-z][a-z0-9._-]{0,63}$/; const REVISION = /^(?:[0-9a-f]{40}|local-[0-9a-f]{16})$/;

export class FsExtensionStore implements ExtensionStore {
  readonly root: string;
  constructor(home?: string, private readonly clock: Clock = { now: () => new Date() }) { this.root = extensionsRoot(home); }

  #ensure(): Result<void> {
    try { mkdirSync(this.root, { recursive: true, mode: 0o700 }); chmodSync(this.root, 0o700); return ok(undefined); }
    catch { return err("io", "Could not create the extensions directory."); }
  }

  read(): Result<ExtensionState> {
    const path = join(this.root, "state.json");
    if (!existsSync(path)) return ok(emptyState());
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return err("state_corrupt", `${path} is not a regular file under 8 MB.`);
      return parseState(JSON.parse(readFileSync(path, "utf8")));
    } catch { return err("state_corrupt", `${path} is not valid JSON; fix or remove it.`); }
  }

  update<T>(fn: (state: ExtensionState) => Result<T>): Result<T> {
    const state = this.read(); if (!state.ok) return state;
    const ensured = this.#ensure(); if (!ensured.ok) return ensured;
    const result = fn(state.value); if (!result.ok) return result;
    const temp = join(this.root, `.state-${randomUUID()}.tmp`);
    try { writeFileSync(temp, `${JSON.stringify(state.value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, join(this.root, "state.json")); }
    catch { return err("io", "Could not write extensions/state.json."); }
    finally { rmSync(temp, { force: true }); }
    return result;
  }

  revisionPath(name: string, revision: string, location: RevisionRecord["location"]): string {
    return location.kind === "external" ? location.path : join(this.root, name, revision);
  }

  putRevision(name: string, revision: string, files: readonly FolderFile[], treeHash: string): Result<void> {
    if (!SAFE.test(name) || !REVISION.test(revision)) return err("bad_source", "Unsafe extension name or revision.");
    const ensured = this.#ensure(); if (!ensured.ok) return ensured;
    const target = join(this.root, name, revision);
    try {
      if (existsSync(target)) {
        const current = readFolder(target);
        return current.ok && gitTreeHash(current.value) === treeHash ? ok(undefined) : err("tampered", `${target} exists but does not match revision ${revision}; remove the extension and install again.`);
      }
      const temp = join(this.root, `.staging-${randomUUID()}`);
      mkdirSync(temp, { mode: 0o700 });
      try { writeFolder(temp, files); mkdirSync(join(this.root, name), { recursive: true, mode: 0o700 }); renameSync(temp, target); }
      finally { rmSync(temp, { recursive: true, force: true }); }
      return ok(undefined);
    } catch (error) { return err("io", `Could not write ${target}: ${(error as Error).message}`); }
  }

  readRevision(name: string, revision: string, location: RevisionRecord["location"]): Result<FolderFile[]> {
    const dir = this.revisionPath(name, revision, location);
    if (!existsSync(dir)) return err("missing", `${name}@${revision.slice(0, 12)} is missing from ${dir}.`);
    return readFolder(dir);
  }

  deleteRevisions(name: string, revisions: readonly string[]): Result<void> {
    if (!SAFE.test(name)) return err("bad_source", "Unsafe extension name.");
    try {
      for (const revision of revisions) if (REVISION.test(revision)) rmSync(join(this.root, name, revision), { recursive: true, force: true });
      const dir = join(this.root, name);
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      return ok(undefined);
    } catch (error) { return err("io", (error as Error).message); }
  }

  audit(event: AuditEvent): void {
    try { if (this.#ensure().ok) appendFileSync(join(this.root, "audit.jsonl"), `${JSON.stringify({ at: this.clock.now().toISOString(), ...event })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
  }
}
