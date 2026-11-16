import { err, ok, type Result } from "../core/result.js";
import type { ImportReport } from "../core/state.js";
import type { Clock, ExtensionStore, Importer } from "../ports.js";
import { readLegacy, type LegacyData } from "./legacy-reader.js";
import { planImport } from "./plan.js";

/** One-time importer. Read-only on the old stores; writes only the new state and its own revision folders. Idempotent. */
export class LegacyImporter implements Importer {
  constructor(private readonly deps: { store: ExtensionStore; clock: Clock; read?: () => LegacyData }, private readonly home?: string) {}

  run(options: { force?: boolean } = {}): Result<ImportReport & { alreadyDone: boolean }> {
    const state = this.deps.store.read(); if (!state.ok) return state;
    if (state.value.import && !options.force) return ok({ ...state.value.import, alreadyDone: true });
    const now = this.deps.clock.now().toISOString();
    const plan = planImport((this.deps.read ?? (() => readLegacy(this.home)))(), new Set(Object.keys(state.value.extensions)), now);
    for (const p of plan.entries) if (p.revision) { const w = this.deps.store.putRevision(p.entry.name, p.revision.id, p.revision.files, p.revision.treeHash); if (!w.ok) return w; }
    const report: ImportReport = { importedAt: now, migrated: plan.migrated, notMigrated: plan.notMigrated, notes: plan.notes };
    const saved = this.deps.store.update(s => { for (const p of plan.entries) if (!s.extensions[p.entry.name]) s.extensions[p.entry.name] = p.entry; s.import = report; return ok(undefined); },
      () => ({ event: "extension.import", migrated: plan.migrated.length, notMigrated: plan.notMigrated.length }));
    if (!saved.ok) return err(saved.error.code, saved.error.message);
    return ok({ ...report, alreadyDone: false });
  }
}
