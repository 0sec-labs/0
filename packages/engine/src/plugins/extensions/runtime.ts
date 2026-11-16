/**
 * What may run for a project RIGHT NOW. Only state in ~/.0 decides: a repo's own `.0/` or `.claude/` can suggest
 * extensions (see suggestions.ts) but cannot appear here. Fails closed per extension: a folder that no longer hashes
 * to its pin, whose capabilities moved past the approval, or whose state cannot be read is refused, never loaded.
 */
import { capabilitiesOf, capabilityKey, type Capabilities } from "./core/capabilities.js";
import { extensionEnv } from "./core/env.js";
import { BUILTIN_EXTENSIONS } from "./core/builtins.js";
import { parseManifest, type ExtensionManifest } from "./core/manifest.js";
import { isEnabledFor, statusOf, type RowStatus } from "./core/state.js";
import type { ExtensionStore } from "./ports.js";
import { readVerified } from "./verify.js";

export interface LoadedExtension {
  name: string; revision: string; dir: string; manifest: ExtensionManifest; capabilities: Capabilities; approvedEnv: readonly string[];
  /** Scrubbed environment for a process this extension starts. Provider keys only if declared and approved. */
  env(parent?: Readonly<Record<string, string | undefined>>): Record<string, string>;
}
export type RefusalCode = "tampered" | "capabilities_changed" | "not_approved" | "missing" | "legacy" | "state";
export interface LoadResult { extensions: LoadedExtension[]; builtins: string[]; refused: Array<{ name: string; code: RefusalCode; reason: string }> }

export function loadable(store: ExtensionStore, projectKey: string | null): LoadResult {
  const state = store.read();
  if (!state.ok) return { extensions: [], builtins: [], refused: [{ name: "*", code: "state", reason: state.error.message }] };
  const out: LoadResult = { extensions: [], builtins: BUILTIN_EXTENSIONS.filter(b => state.value.builtins[b.name]?.enabled !== false).map(b => b.name), refused: [] };
  for (const entry of Object.values(state.value.extensions)) {
    if (entry.legacy) { if (isEnabledFor(entry, projectKey)) out.refused.push({ name: entry.name, code: "legacy", reason: entry.legacy.reason }); continue; }
    if (entry.sealBroken) { out.refused.push({ name: entry.name, code: "not_approved", reason: "its approval record did not verify (edited by hand or never sealed): approve it again with `0 skills extensions enable --yes`" }); continue; }
    if (!isEnabledFor(entry, projectKey) || !entry.active) continue;
    const record = entry.revisions[entry.active];
    if (!record?.approvedAt) { out.refused.push({ name: entry.name, code: "not_approved", reason: "not approved: re-approve it with `0 skills extensions enable --yes`" }); continue; }
    const files = readVerified(store, entry, entry.active);
    if (!files.ok) { out.refused.push({ name: entry.name, code: files.error.code === "tampered" ? "tampered" : "missing", reason: files.error.message }); continue; }
    const manifest = parseManifest(files.value, { fallbackName: entry.name });
    if (!manifest.ok) { out.refused.push({ name: entry.name, code: "missing", reason: manifest.error.message }); continue; }
    const capabilities = capabilitiesOf(manifest.value);
    if (capabilityKey(capabilities) !== record.approvedCapabilityKey) { out.refused.push({ name: entry.name, code: "capabilities_changed", reason: "its capabilities differ from what was approved" }); continue; }
    const dir = store.revisionPath(entry.name, entry.active, record.location); const approvedEnv = record.approvedEnv;
    out.extensions.push({ name: entry.name, revision: entry.active, dir, manifest: manifest.value, capabilities, approvedEnv, env: (parent = process.env) => extensionEnv({ declared: capabilities.env, approved: approvedEnv, parent, extra: { ZERO_EXTENSION_NAME: entry.name, ZERO_EXTENSION_DIR: dir } }) });
  }
  return out;
}

export interface ListRow { name: string; kind: "built-in" | "git" | "local" | "unmigrated"; revision: string | null; version: string; status: RowStatus | "built-in"; enabled: boolean; projects: string[]; detail: string }

export function listRows(store: ExtensionStore, projectKey: string | null): { rows: ListRow[]; error?: string } {
  const state = store.read(); if (!state.ok) return { rows: [], error: state.error.message };
  const rows: ListRow[] = BUILTIN_EXTENSIONS.map(b => ({ name: b.name, kind: "built-in", revision: null, version: b.version, status: "built-in", enabled: state.value.builtins[b.name]?.enabled !== false, projects: [], detail: b.description }));
  for (const e of Object.values(state.value.extensions).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const record = e.active ? e.revisions[e.active] : undefined;
    rows.push({ name: e.name, kind: e.legacy ? "unmigrated" : e.source?.type ?? "local", revision: e.active, version: record?.version ?? "", status: statusOf(e, projectKey), enabled: isEnabledFor(e, projectKey), projects: e.enabled.projects, detail: e.note ?? e.legacy?.reason ?? "" });
  }
  return { rows };
}
