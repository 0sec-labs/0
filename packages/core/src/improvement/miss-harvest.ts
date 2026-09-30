/**
 * Flywheel connector: benchmark MISS → lens-synth curated-miss input (0).
 *
 * The self-improvement flywheel already has two halves:
 *   - bench:     tournament → scorecard → champion (the falsifiable capability
 *                number, with a deterministic per-case verdict).
 *   - lens-synth: turns a CONFIRMED finder miss into a validated, corpus-gated
 *                appsec finder lens (`runLensSynthesisLoop`, fed a `MissInput`).
 *
 * The missing piece was the hand-off: automatically turning the champion's
 * FALSE-NEGATIVES on the labeled corpus (positive `finding-match` cases the
 * champion `refuted` — ran to completion but did not surface the expected
 * in-class finding at the expected sink) into the `confirmedMisses` the
 * lens-synth loop consumes.
 *
 * This module is PURE and side-effect-free: it maps a completed bench result
 * (a tournament, a ledger entry, or a champion scorecard) plus the manifest
 * (for the ground-truth vuln class + sink markers, which the per-case result
 * does not carry) into a {@link ConfirmedMiss}[] / {@link MissInput}.
 *
 * ============================================================================
 * GATE INVARIANT: this connector FEEDS the pipeline; it never bypasses the
 * corpus-gated promotion. It emits only the `misses` half of a
 * {@link LensSynthesisInput}; the operator still supplies the validation
 * `corpus` (positives / negative-controls / held-out on disk) and lens-synth
 * still runs its fail-closed tournament validation before any registration.
 * A champion PASS is never harvested; only genuine, ran-to-completion
 * false-negatives are.
 * ============================================================================
 */

import type { BenchCase, BenchManifest } from "../bench/manifest.js";
import type { BenchScorecard } from "../bench/scorecard.js";
import type { TournamentResult } from "../bench/tournament.js";
import type { LedgerEntry } from "../bench/ledger.js";
import type { ConfirmedMiss, MissInput } from "../stages/lens-synthesis/types.js";

/** Why a bench case was NOT harvested as a lens-synth miss. */
export type MissSkipReason =
  | "known-negative"
  | "not-finding-match"
  | "champion-passed"
  | "inconclusive"
  | "missing-manifest-case";

/** One skipped case, retained for an auditable, deterministic harvest record. */
export interface SkippedCase {
  caseId: string;
  reason: MissSkipReason;
}

/** The auditable result of harvesting misses off one champion scorecard. */
export interface MissHarvestResult {
  manifestId: string;
  /** The variant whose false-negatives were harvested. */
  championId: string;
  /** The curated misses, one per harvested false-negative case, id-sorted. */
  misses: ConfirmedMiss[];
  /** Case ids that produced a miss, id-sorted. */
  harvestedCaseIds: string[];
  /** Cases considered but not harvested, with the reason. Id-sorted. */
  skipped: SkippedCase[];
}

/**
 * Only source-audit `finding-match` cases carry a ground-truth vuln CLASS +
 * SINK, which is exactly the shape an appsec finder lens is synthesized from.
 * Runtime (web/kernel/suite) objectives grade against an injected marker and
 * have no class/sink to seed a lens, so they are not mappable misses.
 */
function findingMatchCase(
  c: BenchCase | undefined,
): (BenchCase & { objective: { type: "finding-match"; vulnClass: string; sinkMarkers: string[] }; target: { kind: "source-audit"; package: string; version: string; ecosystem: string } }) | null {
  if (!c) return null;
  if (c.objective.type !== "finding-match") return null;
  if (c.target.kind !== "source-audit") return null;
  return c as never;
}

/** Deterministic source/target reference for a source-audit case. */
function targetRef(target: { ecosystem: string; package: string; version: string }): string {
  return `${target.ecosystem}:${target.package}@${target.version}`;
}

/** The class + sink the champion should have surfaced, phrased as a miss. */
function toConfirmedMiss(
  c: BenchCase & {
    objective: { type: "finding-match"; vulnClass: string; sinkMarkers: string[] };
    target: { kind: "source-audit"; package: string; version: string; ecosystem: string };
  },
  championId: string,
  manifestId: string,
): ConfirmedMiss {
  const ref = targetRef(c.target);
  // Preserve every ground-truth sink marker so synthesis can cite the concrete
  // sink; join deterministically (markers are ordered by the manifest author).
  const sinkPattern = c.objective.sinkMarkers.join(" | ");
  return {
    classHint: c.objective.vulnClass,
    sinkPattern,
    // A source-audit case has no single line; the package coordinate is the
    // stable, non-empty target reference miss-capture normalizes into
    // `exampleFileLine`. The concrete sink lives in `sinkPattern`.
    file: ref,
    whyMissed:
      `champion "${championId}" refuted positive finding-match case "${c.id}" ` +
      `in bench "${manifestId}" — expected a ${c.objective.vulnClass} finding at ` +
      `[${c.objective.sinkMarkers.join(", ")}] in ${ref}, none surfaced (false negative)`,
  };
}

/**
 * Harvest the champion's false-negatives off a completed scorecard.
 *
 * A miss is a POSITIVE (`!knownNegative`) `finding-match` case whose case-level
 * verdict is `refuted` — the champion ran to completion and did not surface the
 * expected in-class finding at the expected sink. Cases the champion `verified`
 * (passed) are NEVER harvested; `inconclusive` cases (an infra/timeout failure,
 * not a coverage gap) are skipped fail-closed.
 *
 * Pure: identical inputs yield a byte-identical, id-sorted result.
 *
 * @param scorecard the champion variant's scorecard (its `cases` carry the verdict)
 * @param manifest  the manifest the run graded, for each case's vuln class + sink
 * @param championId a label for provenance; defaults to the scorecard's manifestId
 */
export function harvestMissesFromScorecard(
  scorecard: BenchScorecard,
  manifest: BenchManifest,
  championId: string = scorecard.manifestId,
): MissHarvestResult {
  const caseById = new Map<string, BenchCase>(manifest.cases.map((c) => [c.id, c]));
  const misses: ConfirmedMiss[] = [];
  const harvestedCaseIds: string[] = [];
  const skipped: SkippedCase[] = [];

  for (const result of scorecard.cases) {
    const manifestCase = caseById.get(result.id);
    if (!manifestCase) {
      skipped.push({ caseId: result.id, reason: "missing-manifest-case" });
      continue;
    }
    if (result.knownNegative) {
      skipped.push({ caseId: result.id, reason: "known-negative" });
      continue;
    }
    const fm = findingMatchCase(manifestCase);
    if (!fm) {
      skipped.push({ caseId: result.id, reason: "not-finding-match" });
      continue;
    }
    if (result.verdict === "verified") {
      // The champion PASSED this case — never a miss.
      skipped.push({ caseId: result.id, reason: "champion-passed" });
      continue;
    }
    if (result.verdict === "inconclusive") {
      // Scan did not complete — a flaky run, not a coverage gap. Fail closed.
      skipped.push({ caseId: result.id, reason: "inconclusive" });
      continue;
    }
    // verdict === "refuted": a genuine, ran-to-completion false negative.
    misses.push(toConfirmedMiss(fm, championId, scorecard.manifestId));
    harvestedCaseIds.push(result.id);
  }

  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  misses.sort((a, b) => byId(a.file + a.classHint, b.file + b.classHint));
  harvestedCaseIds.sort(byId);
  skipped.sort((a, b) => byId(a.caseId, b.caseId));

  return {
    manifestId: scorecard.manifestId,
    championId,
    misses,
    harvestedCaseIds,
    skipped,
  };
}

/**
 * Harvest misses off a completed tournament: locate the champion variant's
 * scorecard by {@link TournamentResult.championId} and harvest its
 * false-negatives.
 */
export function harvestMissesFromTournament(
  tournament: TournamentResult,
  manifest: BenchManifest,
): MissHarvestResult {
  const champion = tournament.variants.find((v) => v.variant.id === tournament.championId);
  if (!champion) {
    throw new Error(
      `harvestMissesFromTournament: champion "${tournament.championId}" not among variants [${tournament.variants
        .map((v) => v.variant.id)
        .join(", ")}]`,
    );
  }
  return harvestMissesFromScorecard(champion.scorecard, manifest, tournament.championId);
}

/**
 * Harvest misses off a benchmark ledger entry (a persisted champion run).
 */
export function harvestMissesFromLedgerEntry(
  entry: LedgerEntry,
  manifest: BenchManifest,
): MissHarvestResult {
  return harvestMissesFromScorecard(entry.scorecard, manifest, entry.championId);
}

/**
 * Project a harvest result into the exact `misses` shape the lens-synth loop
 * consumes ({@link MissInput}). Emits ONLY `confirmedMisses` — the strongest
 * miss signal — leaving `incompleteCoverage` / `curatedCandidates` empty so a
 * caller can union them with other sources.
 *
 * The `corpus` half of a {@link LensSynthesisInput} is intentionally NOT
 * produced here: the corpus is the operator-curated, on-disk, gated evidence,
 * and inferring it from a package coordinate would bypass the promotion gate.
 */
export function harvestedMissesToMissInput(result: MissHarvestResult): MissInput {
  return { confirmedMisses: result.misses };
}

/**
 * Union harvested confirmed misses into an existing {@link MissInput}, de-duping
 * on (classHint, sinkPattern, file, line) so re-running the connector against
 * the same ledger is idempotent. Pure — returns a new object.
 */
export function mergeHarvestedMisses(base: MissInput, harvested: ConfirmedMiss[]): MissInput {
  const existing = base.confirmedMisses ?? [];
  const key = (m: ConfirmedMiss): string =>
    JSON.stringify([m.classHint, m.sinkPattern, m.file, m.line ?? null]);
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  for (const m of harvested) {
    const k = key(m);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(m);
  }
  return { ...base, confirmedMisses: merged };
}
