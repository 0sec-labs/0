import { compareFindingsByBusinessPriority, getFindingPriority } from "@0/shared";
import type { ShimmedDatabase } from "./wasm-shim.js";
import type * as schema from "./schema.js";

export interface BusinessPriorityFindingOptions {
  scanId?: string; severity?: string; category?: string; status?: string; triageStatus?: string;
  /** Maximum latest family representatives. Historical evidence bodies are never loaded to rank them. */
  limit?: number;
}
export interface FindingFamilyPrioritySummary {
  key: string;
  latest: typeof schema.findings.$inferSelect;
  count: number;
  scanCount: number;
  verdictCounts: { truePositive: number; falsePositive: number; unsure: number; total: number };
  /** One actual running session per active role; conversations and tool contexts are excluded. */
  activeSessions: Array<{ id: string; scanId: string; status: string; agentRole: string; createdAt: string; updatedAt: string }>;
}
interface Metadata {
  id: string; familyKey: string; timestamp: number; severity: string; cvssScore: number | null;
  impactAssessment: string | null;
}
export interface LatestFindingMetadata extends Metadata {
  category: string; status: string; triageStatus: string;
}
/** Pages contain bounded assessment JSON only; evidence and descriptions are excluded.
 * No read transaction or native cursor is held while the caller processes a yielded row.
 */
export function* iterateLatestFindingMetadata(sqlite: ShimmedDatabase, opts: Omit<BusinessPriorityFindingOptions, "limit"> = {}): Generator<LatestFindingMetadata> {
  let afterId: string | null = null;
  while (true) {
    const page = sqlite.prepare(`SELECT f.id,COALESCE(f.fingerprint,f.id) AS familyKey,f.timestamp,f.severity,f.category,f.status,f.triageStatus,f.cvssScore,
      CASE WHEN length(CAST(f.impactAssessment AS BLOB)) <= ${MAX_ASSESSMENT_BYTES} THEN f.impactAssessment ELSE NULL END AS impactAssessment
      FROM findings f WHERE (@afterId IS NULL OR f.id>@afterId) AND (@scanId IS NULL OR f.scanId=@scanId)
      AND NOT EXISTS (SELECT 1 FROM findings newer WHERE COALESCE(newer.fingerprint,newer.id)=COALESCE(f.fingerprint,f.id)
        AND (@scanId IS NULL OR newer.scanId=@scanId) AND (newer.timestamp>f.timestamp OR (newer.timestamp=f.timestamp AND newer.id>f.id)))
      AND (@severity IS NULL OR f.severity=@severity) AND (@category IS NULL OR f.category=@category)
      AND (@status IS NULL OR f.status=@status) AND (@triageStatus IS NULL OR f.triageStatus=@triageStatus)
      ORDER BY f.id LIMIT ${PAGE_SIZE}`).all({afterId, scanId: opts.scanId ?? null, severity: opts.severity ?? null,
        category: opts.category ?? null, status: opts.status ?? null, triageStatus: opts.triageStatus ?? null}) as unknown as LatestFindingMetadata[];
    yield* page;
    if (page.length < PAGE_SIZE) return;
    afterId = page[page.length - 1]!.id;
  }
}
export function getFindingFamilyMetadata(sqlite: ShimmedDatabase, key: string, opts: {scanId?: string} = {}): {count: number; scanIds: string[]} {
  const rows = sqlite.prepare(`SELECT scanId,COUNT(*) AS count FROM findings WHERE COALESCE(fingerprint,id)=@key
    AND (@scanId IS NULL OR scanId=@scanId) GROUP BY scanId ORDER BY scanId`).all({key,scanId:opts.scanId ?? null}) as Array<{scanId:string;count:number}>;
  return {count: rows.reduce((sum,row)=>sum+row.count,0),scanIds: rows.map(row=>row.scanId)};
}
interface Candidate extends Omit<Metadata, "impactAssessment"> { businessPriorityRank: number }
function compare(a: Candidate, b: Candidate): number {
  return b.businessPriorityRank - a.businessPriorityRank || compareFindingsByBusinessPriority(a, b) || b.timestamp - a.timestamp || b.id.localeCompare(a.id);
}
/** Worst retained item at the root: memory is bounded by the requested limit. */
function retain(heap: Candidate[], item: Candidate, limit: number): void {
  if (heap.length < limit) {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) { const parent = Math.floor((index - 1) / 2); if (compare(heap[index]!, heap[parent]!) <= 0) break; [heap[index], heap[parent]] = [heap[parent]!, heap[index]!]; index = parent; }
    return;
  }
  if (compare(item, heap[0]!) >= 0) return;
  heap[0] = item;
  let index = 0;
  while (true) {
    let worst = index;
    for (const child of [index * 2 + 1, index * 2 + 2]) if (child < heap.length && compare(heap[child]!, heap[worst]!) > 0) worst = child;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst]!, heap[index]!]; index = worst;
  }
}
const PAGE_SIZE = 500;
// Covers every schema-bounded field even when JSON escapes each UTF-16 code unit.
const MAX_ASSESSMENT_BYTES = 80 * 1024;
/** Latest family state is selected before filtering and global business ranking, in one read snapshot. */
function rankedFindingRows(sqlite: ShimmedDatabase, opts: BusinessPriorityFindingOptions, latestOnly: boolean): Array<typeof schema.findings.$inferSelect> {
  const limit = opts.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 5000) throw new Error("Business-priority finding limit must be an integer between 0 and 5000.");
  if (limit === 0) return [];
    const heap: Candidate[] = [];
    let afterId: string | null = null;
    const statement = sqlite.prepare(`
      SELECT f.id, COALESCE(f.fingerprint, f.id) AS familyKey, f.timestamp, f.severity, f.cvssScore,
        CASE WHEN length(CAST(f.impactAssessment AS BLOB)) <= ${MAX_ASSESSMENT_BYTES} THEN f.impactAssessment ELSE NULL END AS impactAssessment
      FROM findings f
      WHERE (@afterId IS NULL OR f.id > @afterId)
        AND (@scanId IS NULL OR f.scanId = @scanId)
        AND (@latestOnly = 0 OR NOT EXISTS (SELECT 1 FROM findings newer
          WHERE COALESCE(newer.fingerprint, newer.id) = COALESCE(f.fingerprint, f.id)
            AND (@scanId IS NULL OR newer.scanId = @scanId)
            AND (newer.timestamp > f.timestamp OR (newer.timestamp = f.timestamp AND newer.id > f.id))))
        AND (@severity IS NULL OR f.severity = @severity)
        AND (@category IS NULL OR f.category = @category)
        AND (@status IS NULL OR f.status = @status)
        AND (@triageStatus IS NULL OR f.triageStatus = @triageStatus)
      ORDER BY f.id LIMIT ${PAGE_SIZE}`);
    while (true) {
      const page = statement.all({ latestOnly: latestOnly ? 1 : 0, afterId, scanId: opts.scanId ?? null, severity: opts.severity ?? null, category: opts.category ?? null, status: opts.status ?? null, triageStatus: opts.triageStatus ?? null }) as unknown as Metadata[];
      for (const row of page) {
        let impactAssessment: unknown;
        try { impactAssessment = row.impactAssessment ? JSON.parse(row.impactAssessment) : undefined; } catch { /* Malformed assessments remain unassessed. */ }
        const { impactAssessment: _serialized, ...metadata } = row;
        retain(heap, { ...metadata, businessPriorityRank: getFindingPriority({ impactAssessment }).rank }, limit);
      }
      if (page.length < PAGE_SIZE) break;
      afterId = page[page.length - 1]!.id;
    }
    const selected = heap.sort(compare);
    const rows = new Map<string, typeof schema.findings.$inferSelect>();
    for (let offset = 0; offset < selected.length; offset += 300) {
      const ids = selected.slice(offset, offset + 300).map(item => item.id);
      for (const row of sqlite.prepare(`SELECT * FROM findings WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<typeof schema.findings.$inferSelect>) rows.set(row.id, row);
    }
    return selected.map(item => rows.get(item.id)!);
}

/** Historical rows remain individually visible for native --all views. */
export function selectFindingsByBusinessPriority(sqlite: ShimmedDatabase, opts: BusinessPriorityFindingOptions = {}): Array<typeof schema.findings.$inferSelect> {
  return sqlite.transaction(() => rankedFindingRows(sqlite, opts, false))();
}

/** Latest family assessments determine ranking; history contributes counts and review state only. */
export function selectFindingFamiliesByBusinessPriority(sqlite: ShimmedDatabase, opts: BusinessPriorityFindingOptions = {}): FindingFamilyPrioritySummary[] {
  return sqlite.transaction(() => {
    return rankedFindingRows(sqlite, opts, true).map(item => {
      const params = { key: item.fingerprint ?? item.id, scanId: opts.scanId ?? null };
      const counts = sqlite.prepare(`SELECT COUNT(*) AS count, COUNT(DISTINCT scanId) AS scanCount FROM findings
        WHERE COALESCE(fingerprint,id)=@key AND (@scanId IS NULL OR scanId=@scanId)`).get(params) as { count: number; scanCount: number };
      const verdictCounts = sqlite.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN v.verdict='TRUE_POSITIVE' THEN 1 ELSE 0 END),0) AS truePositive,
        COALESCE(SUM(CASE WHEN v.verdict='FALSE_POSITIVE' THEN 1 ELSE 0 END),0) AS falsePositive,
        COALESCE(SUM(CASE WHEN v.verdict NOT IN ('TRUE_POSITIVE','FALSE_POSITIVE') THEN 1 ELSE 0 END),0) AS unsure
        FROM verdicts v JOIN findings f ON f.id=v.findingId
        WHERE COALESCE(f.fingerprint,f.id)=@key AND (@scanId IS NULL OR f.scanId=@scanId)`).get(params) as FindingFamilyPrioritySummary["verdictCounts"];
      const activeSessions = sqlite.prepare(`SELECT s.id,s.scanId,s.status,s.agentRole,s.createdAt,s.updatedAt FROM agent_sessions s
        WHERE s.status='running' AND EXISTS (SELECT 1 FROM findings f WHERE f.scanId=s.scanId
          AND COALESCE(f.fingerprint,f.id)=@key AND (@scanId IS NULL OR f.scanId=@scanId))
        AND NOT EXISTS (SELECT 1 FROM agent_sessions newer WHERE newer.status='running' AND newer.agentRole=s.agentRole
          AND (newer.updatedAt>s.updatedAt OR (newer.updatedAt=s.updatedAt AND newer.id>s.id))
          AND EXISTS (SELECT 1 FROM findings f WHERE f.scanId=newer.scanId
            AND COALESCE(f.fingerprint,f.id)=@key AND (@scanId IS NULL OR f.scanId=@scanId)))
        ORDER BY s.agentRole`).all(params) as FindingFamilyPrioritySummary["activeSessions"];
      return { key: item.fingerprint ?? item.id, latest: item, ...counts, verdictCounts, activeSessions };
    });
  })();
}
