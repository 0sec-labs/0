// Shared helpers for tool-level dedup / similarity logic.
//
// 0#281 — `saveFinding` needs cheap fuzzy title comparison so the same
// SQLi reported across attack + verify stages doesn't end up as 3 advisory
// drafts. Keeping the helpers here lets future call sites (e.g. disclose
// bundle dedup at `bundle.ts:218 assembleBundleIndex`) reuse the same
// normalization + edit-distance functions without pulling in a dep.

/**
 * Normalize a finding title for similarity comparison.
 *
 * - lowercased
 * - non-alphanumeric characters stripped (drops ".php", "/" path slashes,
 *   parentheses, etc. so "SQL Injection in /users" and "SQL injection in
 *   /users.php" collapse)
 * - whitespace collapsed and trimmed
 */
export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Iterative Levenshtein edit distance (insertions, deletions, substitutions
 * each cost 1). O(n * m) time, O(min(n, m)) space via rolling row.
 *
 * Pure helper — no deps, no surprises. Returns `Infinity` only if either
 * input is non-string (defensive; callers should pass strings).
 */
export function levenshtein(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string") return Infinity;
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `b` is the shorter so the rolling row stays small.
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[m];
}

/**
 * 0#281 — fuzzy-title threshold for finding dedup. Levenshtein ≤ 5
 * tolerates typical agent reformulations like "SQL injection in /users" vs
 * "SQL Injection in /users.php" (after normalization) without collapsing
 * legitimately distinct findings such as "/admin/users" vs "/admin/orders"
 * which share a prefix but diverge in the endpoint segment.
 */
export const FUZZY_TITLE_DISTANCE_THRESHOLD = 5;

/**
 * Length of the `evidence.request` prefix used as the third axis of the
 * dedup similarity key. Matches the contract documented on saveFinding.
 */
export const EVIDENCE_REQUEST_PREFIX_LEN = 200;

/**
 * Build the evidence-request prefix used in dedup similarity keys.
 */
export function evidenceRequestPrefix(request: string | undefined | null): string {
  return (request ?? "").slice(0, EVIDENCE_REQUEST_PREFIX_LEN);
}

/**
 * Shared candidate interface for finding similarity deduplication.
 * Satisfied by both in-memory `Finding` records and database row representations.
 */
export interface FindingSimilarityCandidate {
  id: string;
  category?: string | null;
  title?: string | null;
  evidenceRequest?: string | null;
  evidence?: { request?: string | null } | null;
}

/**
 * Extract evidence request string from either in-memory or database candidate.
 */
export function getCandidateEvidenceRequest(
  candidate: FindingSimilarityCandidate,
): string | undefined {
  if (typeof candidate.evidenceRequest === "string") return candidate.evidenceRequest;
  if (candidate.evidence && typeof candidate.evidence.request === "string") return candidate.evidence.request;
  return undefined;
}

export const getFindingCandidateEvidenceRequest = getCandidateEvidenceRequest;

/**
 * Evaluate whether an existing finding matches an incoming finding under the
 * similarity-key invariant: (category, normalizedTitle, evidenceRequestPrefix).
 *
 * Rules:
 * - Category must match strictly.
 * - Evidence prefixes must match strictly.
 * - If normalized titles are identical, findings merge.
 * - Fuzzy title matching (Levenshtein <= FUZZY_TITLE_DISTANCE_THRESHOLD) is
 *   permitted ONLY when both findings have matching non-empty evidence prefixes.
 */
export function isFindingDuplicate(
  existing: FindingSimilarityCandidate,
  incoming: FindingSimilarityCandidate,
): boolean {
  if (!existing.category || !incoming.category || existing.category !== incoming.category) return false;
  const existingPrefix = evidenceRequestPrefix(getFindingCandidateEvidenceRequest(existing));
  const incomingPrefix = evidenceRequestPrefix(getFindingCandidateEvidenceRequest(incoming));
  if (existingPrefix !== incomingPrefix) return false;
  const existingNormTitle = normalizeFindingTitle(existing.title ?? "");
  const incomingNormTitle = normalizeFindingTitle(incoming.title ?? "");
  if (!existingNormTitle || !incomingNormTitle) return false;
  if (existingNormTitle === incomingNormTitle) return true;
  if (!existingPrefix) return false;
  return levenshtein(existingNormTitle, incomingNormTitle) <= FUZZY_TITLE_DISTANCE_THRESHOLD;
}

/**
 * Find the first matching finding in a list of candidates that satisfies the
 * deduplication similarity invariant with the incoming finding.
 */
export function findMatchingFindingCandidate<T extends FindingSimilarityCandidate>(
  candidates: readonly T[],
  incoming: FindingSimilarityCandidate,
): T | undefined {
  const incomingCategory = incoming.category;
  if (!incomingCategory) return undefined;
  const incomingNormTitle = normalizeFindingTitle(incoming.title ?? "");
  if (!incomingNormTitle) return undefined;
  const incomingPrefix = evidenceRequestPrefix(getFindingCandidateEvidenceRequest(incoming));

  return candidates.find((existing) => {
    if (!existing.category || existing.category !== incomingCategory) return false;
    const existingPrefix = evidenceRequestPrefix(getFindingCandidateEvidenceRequest(existing));
    if (existingPrefix !== incomingPrefix) return false;
    const existingNormTitle = normalizeFindingTitle(existing.title ?? "");
    if (!existingNormTitle) return false;
    if (existingNormTitle === incomingNormTitle) return true;
    if (!existingPrefix) return false;
    return levenshtein(existingNormTitle, incomingNormTitle) <= FUZZY_TITLE_DISTANCE_THRESHOLD;
  });
}
