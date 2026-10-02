/**
 * Post-scan finding post-processing: intra-scan semantic dedupe and
 * incremental ranking (flag-gated, default OFF).
 *
 * Runs ONCE after the attack/triage/verify stages, on the final finding set,
 * before the report stage assembles the `ScanReport`. It mutates the
 * in-memory `Finding` objects in place (additive optional fields only):
 *
 *   - semantic dedupe → `finding.semanticDedupe` (canonical mapping + cluster
 *     reason), via `triage/semantic-dedupe.ts`
 *   - incremental ranking → `finding.findingRank` on canonicals, and a
 *     reorder that groups each duplicate directly after its canonical
 *     (cluster order = canonical rank), via `triage/incremental-rank.ts`
 *
 * Both are fail-soft by design: LLM failure never drops a finding (dedupe
 * falls back to singletons, ranking to input order) and the caller wraps the
 * whole pass in try/catch so a post-process error can never fail the scan.
 */

import type { Finding, JevEvaluator } from "@0/shared";
import type { NativeRuntime } from "../runtime/types.js";
import { semanticDedupe, rankIncremental, type DedupeItem, type RankedResult } from "../triage/index.js";

export type { DedupeItem };

/**
 * Minimal interface for loading prior-scan findings from the local DB.
 * Accepts any object shaped like the osecDB subset so tests can fake it
 * without a real database.
 */
export interface PriorScanLoader {
  listScansByTarget(target: string, opts?: { limit?: number }): Array<{ id: string; status: string; target: string }>;
  getScanFindings(scanId: string): Array<{
    id: string;
    title: string;
    category: string;
    description: string;
    // Persisted as serialized JSON (see @0/db findings.reviewAnnotation);
    // accepted in both forms for the same reason semanticDedupe is.
    reviewAnnotation?: { path?: string; startLine?: number } | string | null;
    semanticDedupe?: { isCanonical?: boolean } | string | null;
  }>;
}

/** Options for the post-scan post-process pass. */
export interface FindingPostProcessOptions {
  /** Run the semantic dedupe pass (ZERO_FEATURE_SEMANTIC_DEDUPE). */
  semanticDedupe?: boolean;
  /** Run the incremental ranking pass (ZERO_FEATURE_INCREMENTAL_RANK). */
  incrementalRank?: boolean;
  /** Scan identifier used to build stable cluster ids. */
  scanId?: string;
  /** Anchors from prior runs — already-canonical findings presented as immutable. */
  anchors?: DedupeItem[];
  /** Optional bounded pair scorer; ambiguous pairs retain the stronger-model path. */
  jevEvaluator?: JevEvaluator;
  /** Independent opt-in advisory rank scorer; jevEvaluator above remains dedupe-only. */
  jevRankEvaluator?: JevEvaluator;
  /** Observe advisory metadata after ranks/order are applied; observer failures are isolated. */
  onRank?: (updates: readonly RankedResult[]) => void;
  signal?: AbortSignal;
}

/**
 * Project a `Finding` into the compact `DedupeItem` shape the LLM post-pass
 * consumes. Location prefers the structured review annotation, else falls
 * back to a generic placeholder (never fabricates a path).
 */
function toDedupeItem(f: Finding): DedupeItem {
  const loc = f.reviewAnnotation
    ? `${f.reviewAnnotation.path}:${f.reviewAnnotation.startLine}`
    : "unknown";
  return {
    id: f.id,
    summary: f.title,
    category: f.category,
    location: loc,
    description: f.description ?? "",
  };
}

/**
 * The review annotation is stored as serialized JSON, so a row read
 * straight from the database hands it over as a string. Parse defensively:
 * a malformed payload must degrade to "no location", never throw during a
 * scan post-process pass.
 */
function parseReviewAnnotation(
  value: { path?: string; startLine?: number } | string | null | undefined,
): { path?: string; startLine?: number } | null {
  if (value == null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as { path?: string; startLine?: number };
}

function isPersistedDuplicate(
  semanticDedupe: { isCanonical?: boolean } | string | null | undefined,
): boolean {
  if (semanticDedupe == null) return false;
  let parsed: unknown = semanticDedupe;
  if (typeof semanticDedupe === "string") {
    try {
      parsed = JSON.parse(semanticDedupe);
    } catch {
      return false;
    }
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "isCanonical" in parsed &&
    parsed.isCanonical === false
  );
}

/**
 * Load finding anchors from the most recent prior scan for the same target.
 * Returns up to `opts.limit` (default 100) `DedupeItem` projections, or []
 * when there is no prior scan or it has no findings.
 */
export async function loadPriorScanAnchors(
  db: PriorScanLoader,
  target: string,
  opts?: { excludeScanId?: string; limit?: number },
): Promise<DedupeItem[]> {
  const scans = db.listScansByTarget(target, { limit: 5 });
  // Find the latest prior scan excluding the given scanId
  const prior = opts?.excludeScanId
    ? scans.find((s) => s.id !== opts.excludeScanId)
    : scans[0];
  if (!prior) return [];

  const findings = db.getScanFindings(prior.id);
  if (!findings || findings.length === 0) return [];

  const limit = opts?.limit ?? 100;
  const items: DedupeItem[] = [];
  for (const f of findings) {
    // A persisted non-canonical finding is already represented by its cluster
    // anchor. Do not bloat later prompts or let it compete as a second anchor.
    if (isPersistedDuplicate(f.semanticDedupe)) continue;
    if (items.length >= limit) break;
    const annotation = parseReviewAnnotation(f.reviewAnnotation);
    const loc = annotation
      ? `${annotation.path ?? "unknown"}:${annotation.startLine ?? 0}`
      : "unknown";
    items.push({
      id: f.id,
      summary: f.title,
      category: f.category,
      location: loc,
      description: f.description ?? "",
    });
  }

  return items;
}

/**
 * Run the flag-gated post-pass over the final finding set.
 *
 * Order: dedupe first (canonical mapping), then rank ONLY the canonicals
 * (duplicates inherit their canonical's position via the sort key). Mutates
 * `findings` in place; returns the number of duplicates collapsed.
 */
export async function applyFindingPostProcess(
  findings: Finding[],
  runtime: NativeRuntime,
  opts: FindingPostProcessOptions = {},
): Promise<number> {
  if (findings.length === 0) return 0;
  opts.signal?.throwIfAborted();

  let duplicateCount = 0;

  if (opts.semanticDedupe || opts.jevEvaluator) {
    const items = findings.map(toDedupeItem);
    const result = await semanticDedupe(items, runtime, {
      scanId: opts.scanId,
      anchors: opts.anchors,
      jevEvaluator: opts.jevEvaluator,
      signal: opts.signal,
    });
    for (const f of findings) {
      const m = result.mappings[f.id];
      if (m) {
        f.semanticDedupe = m;
        if (!m.isCanonical) duplicateCount += 1;
      }
    }
  }

  if (opts.incrementalRank || opts.jevRankEvaluator) {
    // Rank only canonical findings; duplicates inherit the canonical's rank
    // as the sort key so clusters stay grouped in report order.
    const canonicals = findings.filter((f) => f.semanticDedupe?.isCanonical ?? true);
    const { updates } = await rankIncremental(
      canonicals.map((f) => {
        const item = { ...toDedupeItem(f), businessContext: f.impactAssessment ? JSON.stringify(f.impactAssessment).slice(0, 2_000) : "Business consequences and deployment context are unassessed." };
        if (!opts.jevRankEvaluator) return item;
        const receipt = f.verification_result;
        return {
          ...item,
          evidence: JSON.stringify({
            request: f.evidence.request.slice(0, 600),
            response: f.evidence.response.slice(0, 800),
            analysis: f.evidence.analysis?.slice(0, 400),
          }).slice(0, 2_000),
          // Only actual replay receipts, never the unexecuted verificationSpec or PoC plan.
          verification: receipt ? JSON.stringify({
            status: receipt.status,
            mode: receipt.mode,
            evidence_kind: receipt.evidence_kind,
            summary: receipt.summary?.slice(0, 300),
            assertions: receipt.assertions.slice(0, 2).map((assertion) => ({
              kind: assertion.kind,
              target: assertion.target.slice(0, 128),
              expected: typeof assertion.expected === "string" ? assertion.expected.slice(0, 128) : assertion.expected,
              actual: typeof assertion.actual === "string" ? assertion.actual.slice(0, 128) : assertion.actual,
              passed: assertion.passed,
            })),
          }).slice(0, 1_000) : undefined,
        };
      }),
      runtime,
      { jevEvaluator: opts.jevRankEvaluator, signal: opts.signal },
    );
    opts.signal?.throwIfAborted();
    const rankById = new Map(updates.map((u) => [u.id, u.rank]));
    for (const f of canonicals) {
      const rank = rankById.get(f.id);
      if (rank !== undefined) f.findingRank = rank;
    }
    const clusterRankOf = (f: Finding): number => {
      const keyId = f.semanticDedupe?.canonicalId ?? f.id;
      return rankById.get(keyId) ?? Number.MAX_SAFE_INTEGER;
    };
    findings.sort((a, b) => clusterRankOf(a) - clusterRankOf(b));
    try {
      await opts.onRank?.(updates);
    } catch {
      // Observers do not own ranking or vulnerability state.
    }
  }

  return duplicateCount;
}