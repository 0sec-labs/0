/**
 * Built-in enablement has ONE store: `extensions/state.json` (`builtins`). This module reads and writes it for the
 * older `0 plugin` view and migrates, once, the per-project schema-2 enablement records that used to hold it.
 *
 *   read:   state.json decides (explicit, on, off). Nothing recorded there yet -> migrate the old per-project
 *           records once, else the built-in's default (on, not strict).
 *   corrupt: a parseable schema-2 record of THIS project with a broken `enabled` field, before migration, is
 *           `corrupt`: with a scope defined the caller denies with a clear message; with none it is default on.
 *   write:  only state.json; the old per-project files are never read again after the migration.
 *
 * Built-in enablement is global (it used to be per project). A project that disabled scope before the migration is
 * migrated as disabled for everyone; disabled means "deny while a scope is defined", which is the safe direction.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FsExtensionStore } from "./extensions/adapters/fs-store.js";
import { ok } from "./extensions/core/result.js";
import { BUILTIN_EXTENSIONS } from "./extensions/core/builtins.js";

export type BuiltinEnablement = { readonly kind: "default" | "on" | "explicit" | "off" | "corrupt"; readonly message?: string };
export interface LegacyLocation { readonly dir: string; readonly projectFile: string }

const MAX_BYTES = 1024 * 1024;
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readLegacyFile(path: string): unknown {
  try { if (!lstatSync(path).isFile() || lstatSync(path).size > MAX_BYTES) return undefined; return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
const schemaOf = (record: Record<string, unknown>): number => (typeof record["schema"] === "number" ? record["schema"] : 1);

/** Old per-project records, folded: explicit enable beats disable beats nothing. */
function foldLegacy(legacy: LegacyLocation, ids: readonly string[]): Record<string, "explicit" | "off" | "default"> {
  const out: Record<string, "explicit" | "off" | "default"> = Object.fromEntries(ids.map(id => [id, "default" as const]));
  let files: string[] = [];
  try { files = readdirSync(legacy.dir).filter(f => f.endsWith(".json")); } catch { return out; }
  for (const file of files) {
    const record = readLegacyFile(join(legacy.dir, file));
    if (!plain(record) || !plain(record["enabled"])) continue;
    const enabled = record["enabled"]; const current = schemaOf(record) >= 2;
    for (const id of ids) {
      const entry = enabled[id];
      if (plain(entry) && entry["origin"] !== "default") out[id] = "explicit";
      else if (entry === undefined && current && out[id] !== "explicit") out[id] = "off";
    }
  }
  return out;
}

/** This project's own schema-2 record parses as JSON but its `enabled` field is not a record. */
function corruptProjectRecord(legacy: LegacyLocation): string | null {
  if (!existsSync(legacy.projectFile)) return null;
  const record = readLegacyFile(legacy.projectFile);
  if (!plain(record) || schemaOf(record) < 2 || plain(record["enabled"])) return null;
  return `${legacy.projectFile} has a broken \`enabled\` field`;
}

export function readBuiltinEnablement(id: string, legacy: LegacyLocation, home?: string): BuiltinEnablement {
  const store = new FsExtensionStore(home);
  const current = store.builtinState(id);
  if (current.kind !== "default" || store.builtinMigrated()) return current;
  const corrupt = corruptProjectRecord(legacy);
  if (corrupt) return { kind: "corrupt", message: `${corrupt}; fix or remove it (scope cannot tell whether it was turned off, so a defined scope is enforced by denying commands). Re-enable with \`0 skills extensions enable scope\`.` };
  if (!existsSync(legacy.dir)) return { kind: "default" };
  const folded = foldLegacy(legacy, BUILTIN_EXTENSIONS.map(b => b.name));
  const now = new Date().toISOString();
  // Persist once; in an agent session or on a read-only home this fails and the fold is simply recomputed.
  store.update(state => {
    for (const [name, mode] of Object.entries(folded)) if (mode !== "default" && !state.builtins[name]) state.builtins[name] = mode === "explicit" ? { enabled: true, explicit: true, changedAt: now } : { enabled: false, changedAt: now };
    state.migrations.builtinEnablement = now;
    return ok(undefined);
  }, () => ({ event: "extension.builtin-migration", folded }));
  const mode = folded[id] ?? "default";
  return mode === "explicit" ? { kind: "explicit" } : mode === "off" ? { kind: "off" } : { kind: "default" };
}

/** Persist one built-in's mode. False when it could not be recorded (including from an agent session). */
export function writeBuiltinEnablement(id: string, mode: "default" | "explicit" | "off", home?: string): boolean {
  const now = new Date().toISOString();
  return new FsExtensionStore(home).update(state => {
    if (mode === "default") delete state.builtins[id];
    else state.builtins[id] = mode === "explicit" ? { enabled: true, explicit: true, changedAt: now } : { enabled: false, changedAt: now };
    state.migrations.builtinEnablement ??= now;
    return ok(undefined);
  }, () => ({ event: mode === "off" ? "extension.disable" : "extension.enable", name: id, builtin: true, via: "plugin-command" })).ok;
}
