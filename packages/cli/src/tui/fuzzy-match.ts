/**
 * A tiny, dependency-free fuzzy (subsequence) matcher + ranker for the command
 * palette. Pure and total — no theme, no I/O, no allocation beyond a few
 * locals per call — so a property sweep can hammer it and the palette can rank
 * every source (nav commands, slash commands, keybindings) on each keystroke
 * without a measurable cost.
 *
 * ## What "fuzzy" means here
 *
 * A query matches a target when its characters appear in the target IN ORDER,
 * not necessarily adjacent — so `"oa"` matches `"Open agents"` (the `o` of
 * "Open", then the `a` of "agents"). Matching is case-insensitive.
 *
 * ## Ranking
 *
 * A match is scored so that, for the same query, the intuitively "closer"
 * target ranks higher. The dominant term is WHERE the first query character
 * lands:
 *
 *   1. PREFIX — the query is a leading substring of the target ("op" → "Open").
 *   2. WORD-BOUNDARY — the first match sits at the start of a word (after a
 *      space / `-` / `_` / `/` / `.` or a camelCase hump), e.g. "op" → the
 *      "Op" of "Backup Ops".
 *   3. SCATTERED — the first match is mid-word.
 *
 * These three tiers are separated by large fixed bands (1000 / 500 / 0) that no
 * within-tier bonus can bridge for the short strings a palette holds, so the
 * ordering prefix > word-boundary > scattered always holds. Within a tier,
 * contiguous runs and additional word-boundary hits add smaller bonuses, gaps
 * subtract a little, and a shorter target breaks ties — the usual "tighter
 * match wins" behaviour.
 */

/** Score bands for where the FIRST query character lands. */
const PREFIX_BAND = 1000;
const BOUNDARY_BAND = 500;
const SCATTERED_BAND = 0;

/** Within-tier bonuses/penalties (kept well under the band gap of 500). */
const CONTIGUOUS_BONUS = 12;
const BOUNDARY_BONUS = 8;
const GAP_PENALTY = 1;
/** A tiny per-target-length nudge so a shorter target wins an otherwise-tie. */
const LENGTH_WEIGHT = 0.5;

const WORD_SEPARATORS = new Set([" ", "\t", "-", "_", "/", ".", ":", "(", ")", "[", "]"]);

/** True when the char at `index` starts a word (separator-led or a camelCase hump). */
function isWordStart(target: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = target[index - 1] ?? "";
  if (WORD_SEPARATORS.has(prev)) return true;
  const cur = target[index] ?? "";
  // camelCase / PascalCase hump: a lower-case letter or digit followed by an
  // upper-case letter starts a new word ("openAgents" → the "A").
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(cur);
}

/**
 * Score how well `query` fuzzy-matches `target`, or `null` when `query` is not
 * a subsequence of `target`. Higher is a better match. An empty (or
 * whitespace-only) query matches everything with a neutral score of 0, so a
 * cleared filter leaves the caller's own ordering intact. Case-insensitive.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  if (target.length === 0) return null;

  const lowerTarget = target.toLowerCase();

  let qi = 0;
  let firstMatchIndex = -1;
  let prevMatchIndex = -2;
  let contiguousRuns = 0;
  let boundaryHits = 0;
  let gaps = 0;

  for (let ti = 0; ti < target.length && qi < q.length; ti++) {
    if (lowerTarget[ti] !== q[qi]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = ti;
    if (ti === prevMatchIndex + 1) contiguousRuns += 1;
    else if (prevMatchIndex >= 0) gaps += ti - prevMatchIndex - 1;
    // Use the ORIGINAL-case target for boundary detection (camelCase humps).
    if (isWordStart(target, ti)) boundaryHits += 1;
    prevMatchIndex = ti;
    qi += 1;
  }

  if (qi < q.length) return null; // not a subsequence

  let score: number;
  if (firstMatchIndex === 0 && lowerTarget.startsWith(q)) {
    score = PREFIX_BAND;
  } else if (isWordStart(target, firstMatchIndex)) {
    score = BOUNDARY_BAND;
  } else {
    score = SCATTERED_BAND;
  }

  score += contiguousRuns * CONTIGUOUS_BONUS;
  score += boundaryHits * BOUNDARY_BONUS;
  score -= gaps * GAP_PENALTY;
  score -= Math.min(target.length, 200) * LENGTH_WEIGHT;
  return score;
}

/** Whether `query` fuzzy-matches `target` at all (subsequence, case-insensitive). */
export function fuzzyMatches(query: string, target: string): boolean {
  return fuzzyScore(query, target) !== null;
}

/** One ranked item: the original element and the score its haystack earned. */
export interface FuzzyRanked<T> {
  readonly item: T;
  readonly score: number;
}

/**
 * Filter + rank `items` against `query`, keeping only those whose haystack
 * (from `keyOf`) fuzzy-matches, best score first. The sort is STABLE — items
 * with equal scores keep their input order — so an empty query returns the
 * input order untouched and a tie preserves the caller's curation. Bounded by
 * an optional `limit` so a huge source list can never make a keystroke slow.
 */
export function rankFuzzy<T>(
  items: readonly T[],
  query: string,
  keyOf: (item: T) => string,
  limit?: number,
): FuzzyRanked<T>[] {
  const scored: { entry: FuzzyRanked<T>; index: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    const score = fuzzyScore(query, keyOf(item));
    if (score === null) continue;
    scored.push({ entry: { item, score }, index: i });
  }
  scored.sort((a, b) => b.entry.score - a.entry.score || a.index - b.index);
  const ranked = scored.map((s) => s.entry);
  return typeof limit === "number" && limit >= 0 ? ranked.slice(0, limit) : ranked;
}
