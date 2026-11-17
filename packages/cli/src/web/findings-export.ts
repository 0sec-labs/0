import { findingsServiceFor } from "./findings-service.js";
import { mergeFindingSnapshots, retainedFindingSnapshot } from "./report-artifacts.js";

/** Selected findings may live in different databases (shared, scan runs); export reads each from its own. */
export async function retainedFindingsAcrossDatabases(ids: string[], dbPath: string | undefined) {
  const service = findingsServiceFor(dbPath);
  const byDatabase = new Map<string | undefined, string[]>();
  for (const id of new Set(ids)) {
    const owner = await service.sourceOfFinding(id);
    byDatabase.set(owner?.id, [...(byDatabase.get(owner?.id) ?? []), id]);
  }
  const snapshots = [...byDatabase].map(([path, group]) => retainedFindingSnapshot(group, path ?? dbPath));
  return snapshots.length > 1 ? mergeFindingSnapshots(snapshots) : snapshots[0] ?? retainedFindingSnapshot([], dbPath);
}
