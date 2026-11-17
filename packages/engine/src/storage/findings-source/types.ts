import type { osecDB } from "../database.js";
import type { FindingFamilyPrioritySummary } from "../finding-priority.js";
import type * as schema from "../schema.js";

export type FindingRow = typeof schema.findings.$inferSelect;
export type ScanRow = typeof schema.scans.$inferSelect;
export type FindingsSourceKind = "shared" | "run";

/** What one database contributes to the merged Findings view. Plain data, safe to cache. */
export interface SourceSnapshot {
  families: FindingFamilyPrioritySummary[];
  scans: ScanRow[];
}

/**
 * Port for one place findings live: the shared engine database or a per-run scan database.
 * The merge core only sees snapshots; adapters own opening, caching keys and writes.
 */
export interface FindingsSource {
  readonly id: string;
  readonly kind: FindingsSourceKind;
  /** Cheap change token (file mtime and size). Equal tokens mean a cached snapshot is still valid. */
  version(): string | undefined;
  read(): Promise<SourceSnapshot>;
  /** Run a function against this source's database; the handle is released afterwards. */
  withDatabase<T>(mode: "read" | "write", fn: (db: osecDB) => T | Promise<T>): Promise<T>;
}

export interface SourceRef { id: string; kind: FindingsSourceKind }
export interface FamilyOwner extends SourceRef { scanIds: string[] }

export type FindingProvenance =
  | { kind: "scan"; target: string; startedAt: string; scanId: string }
  | { kind: "agent"; agent: string; target: string; startedAt: string; scanId: string }
  | { kind: "thread"; target: string; startedAt: string; scanId: string }
  | { kind: "ci-import"; target: string; startedAt: string; scanId: string }
  | { kind: "unknown"; scanId: string };

export interface MergedFamily extends FindingFamilyPrioritySummary {
  owners: FamilyOwner[];
  provenance: FindingProvenance;
}
