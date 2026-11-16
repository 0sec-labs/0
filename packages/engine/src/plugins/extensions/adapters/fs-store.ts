/**
 * File-system ExtensionStore under `~/.0/extensions/`:
 *   state.json                       approvals, enablement, built-in enablement, seals, import report (0600)
 *   .seal-key                        per-install HMAC key for the seals (0600); defence in depth, see core/seal.ts
 *   .state.lock                      held while state.json is read-modified-written
 *   audit.jsonl                      install/update/enable/disable/remove events (0600)
 *   <name>/<revision>/...            immutable files per revision (0700)
 * The root is derived from the state-dir helper, so HOME is redirectable in tests.
 */
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AGENT_SESSION_ENV, homeStateDir } from "../../../shared/index.js";
import { gitTreeHash, type FolderFile } from "../core/files.js";
import { err, ok, type Result } from "../core/result.js";
import { sealAll, verifySeals } from "../core/seal.js";
import { emptyState, parseState, type ExtensionState, type RevisionRecord } from "../core/state.js";
import type { AuditEvent, Clock, ExtensionStore } from "../ports.js";
import { readFolder, writeFolder } from "./fs-folder.js";
import { ensureSealKey, readSealKey } from "./seal-key.js";
import { withLock } from "./state-lock.js";

export const extensionsRoot = (home?: string): string => join(homeStateDir(home), "extensions");
const SAFE = /^[a-z][a-z0-9._-]{0,63}$/; const REVISION = /^(?:[0-9a-f]{40}|local-[0-9a-f]{16})$/;

export class FsExtensionStore implements ExtensionStore {
  readonly root: string;
  constructor(home?: string, private readonly clock: Clock = { now: () => new Date() }) { this.root = extensionsRoot(home); }

  #ensure(): Result<void> {
    try { mkdirSync(this.root, { recursive: true, mode: 0o700 }); chmodSync(this.root, 0o700); return ok(undefined); }
    catch { return err("io", "Could not create the extensions directory."); }
  }

  /** Raw JSON of state.json (or null when absent). Distinguishes "no file" from "unreadable". */
  #readRaw(): Result<unknown | null> {
    const path = join(this.root, "state.json");
    if (!existsSync(path)) return ok(null);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return err("state_corrupt", `${path} is not a regular file under 8 MB.`);
      return ok(JSON.parse(readFileSync(path, "utf8")));
    } catch { return err("state_corrupt", `${path} is not valid JSON; fix or remove it.`); }
  }

  /** Parsed state with every unsealed or mismatched record treated as unapproved. */
  read(): Result<ExtensionState> {
    const raw = this.#readRaw(); if (!raw.ok) return raw;
    if (raw.value === null) return ok(emptyState());
    const parsed = parseState(raw.value); if (!parsed.ok) return parsed;
    return ok(verifySeals(parsed.value, readSealKey(this.root)).state);
  }

  #agentRefusal(what: string): Result<never> | null {
    return process.env[AGENT_SESSION_ENV] ? err("agent_session", `Refusing to ${what} from an agent session; approvals are the operator's.`) : null;
  }

  update<T>(fn: (state: ExtensionState) => Result<T>, audit?: (value: T) => AuditEvent): Result<T> {
    const refused = this.#agentRefusal("change extension state"); if (refused) return refused;
    const ensured = this.#ensure(); if (!ensured.ok) return ensured;
    return withLock(join(this.root, ".state.lock"), () => {
      const state = this.read(); if (!state.ok) return state;
      const result = fn(state.value); if (!result.ok) return result;
      let key: Buffer;
      try { key = ensureSealKey(this.root); } catch { return err("io", "Could not create the extensions seal key; nothing was recorded."); }
      // Normalise through the schema first, so what is sealed is exactly what will be read back (unknown fields are dropped).
      const normal = parseState(JSON.parse(JSON.stringify(state.value))); if (!normal.ok) return normal;
      const next = normal.value;
      next.seals = sealAll(next, key);
      // Audit first, fail closed: a change that cannot be audited is not recorded.
      if (audit) { const logged = this.#appendAudit(audit(result.value)); if (!logged.ok) return logged; }
      const temp = join(this.root, `.state-${randomUUID()}.tmp`);
      try { writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, join(this.root, "state.json")); }
      catch { return err("io", "Could not write extensions/state.json."); }
      finally { rmSync(temp, { force: true }); }
      return result;
    });
  }

  /** Whether the one-time import of the old per-project built-in records has run. */
  builtinMigrated(): boolean {
    const raw = this.#readRaw();
    if (!raw.ok || raw.value === null) return false;
    const parsed = parseState(raw.value);
    return parsed.ok && parsed.value.migrations.builtinEnablement !== undefined;
  }

  /** How a built-in is configured, read leniently so an unrelated corrupt field cannot hide it. */
  builtinState(name: string): { kind: "default" | "on" | "explicit" | "off" | "corrupt"; message?: string } {
    const raw = this.#readRaw();
    if (!raw.ok) return { kind: "default" }; // missing or unparseable JSON: schema-2 semantics, default on
    if (raw.value === null) return { kind: "default" };
    const builtins = (raw.value as { builtins?: unknown }).builtins;
    if (builtins === undefined) return { kind: "default" };
    const path = join(this.root, "state.json");
    if (!builtins || typeof builtins !== "object" || Array.isArray(builtins)) return { kind: "corrupt", message: `${path} has a broken \`builtins\` record` };
    const record = (builtins as Record<string, unknown>)[name];
    if (record === undefined) return { kind: "default" };
    if (!record || typeof record !== "object" || typeof (record as { enabled?: unknown }).enabled !== "boolean") return { kind: "corrupt", message: `${path} has a broken enablement record for ${name}` };
    const parsed = parseState(raw.value);
    const sealed = parsed.ok ? verifySeals(parsed.value, readSealKey(this.root)).state.builtins[name] : undefined;
    if (!sealed) return { kind: "default" }; // unsealed or edited by hand: ignored, the default applies
    return { kind: sealed.enabled ? (sealed.explicit ? "explicit" : "on") : "off" };
  }

  revisionPath(name: string, revision: string, location: RevisionRecord["location"]): string {
    return location.kind === "external" ? location.path : join(this.root, name, revision);
  }

  putRevision(name: string, revision: string, files: readonly FolderFile[], treeHash: string): Result<void> {
    const refused = this.#agentRefusal("write an extension revision"); if (refused) return refused;
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

  #appendAudit(event: AuditEvent): Result<void> {
    try { appendFileSync(join(this.root, "audit.jsonl"), `${JSON.stringify({ at: this.clock.now().toISOString(), ...event })}\n`, { mode: 0o600 }); return ok(undefined); }
    catch { return err("io", "Could not append to extensions/audit.jsonl; the change was not recorded."); }
  }
}
