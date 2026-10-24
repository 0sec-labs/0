import { evolutionDigest } from "./registry.js";
import type { EvolutionAttempt } from "./types.js";

export interface DevelopmentArchiveObservation {
  id: string;
  /** Integrity/compatibility admission must precede this projection. */
  attempts: Pick<EvolutionAttempt, "caseId" | "repeat" | "lane" | "matched" | "inconclusive">[];
}

/** Offline policy arms for a predeclared, equal-total-budget study. This does
 * not activate an archive version or change the production parent selector.
 * A descriptor is the set of development cases solved on every repeat: unlike
 * source-text distance, this measures an observed behavior difference. */
export function selectArchiveStudyParent(
  observations: DevelopmentArchiveObservation[],
  options: { policy: "current" | "uniform" | "development-diversity"; seed: string; currentId: string; maxCandidates: number; repeats: number },
): string {
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > 10
    || !Number.isInteger(options.repeats) || options.repeats < 2 || options.repeats > 20
    || !options.seed || options.seed.length > 256) throw new Error("invalid archive study bounds");
  if (observations.length > options.maxCandidates || observations.length === 0) throw new Error("archive candidate cap exceeded or empty");
  const ids = new Set<string>();
  const descriptors = observations.map(observation => {
    if (!observation.id || observation.id.length > 128 || ids.has(observation.id)) throw new Error("invalid archive candidate identity");
    ids.add(observation.id);
    if (!observation.attempts.length || observation.attempts.length > 20_000
      || observation.attempts.some(attempt => attempt.lane !== "development"
        || !attempt.caseId || attempt.caseId.length > 128
        || typeof attempt.matched !== "boolean" || typeof attempt.inconclusive !== "boolean")) {
      throw new Error("archive study accepts bounded development observations only");
    }
    const byCase = new Map<string, typeof observation.attempts>();
    for (const attempt of observation.attempts) {
      const entries = byCase.get(attempt.caseId) ?? [];
      entries.push(attempt);
      byCase.set(attempt.caseId, entries);
    }
    const solved = new Set<string>();
    for (const [caseId, attempts] of byCase) {
      if (attempts.length !== options.repeats || new Set(attempts.map(entry => entry.repeat)).size !== options.repeats
        || attempts.some(entry => !Number.isInteger(entry.repeat) || entry.repeat < 0 || entry.repeat >= options.repeats)) {
        throw new Error("incomplete or duplicate archive study observations");
      }
      if (attempts.every(entry => entry.matched && !entry.inconclusive)) solved.add(caseId);
    }
    return { id: observation.id, cases: [...byCase.keys()].sort(), solved };
  });
  const current = descriptors.find(entry => entry.id === options.currentId);
  if (!current) throw new Error("current parent missing from archive study");
  const corpus = JSON.stringify(current.cases);
  if (descriptors.some(entry => JSON.stringify(entry.cases) !== corpus)) throw new Error("archive study development corpora differ");
  if (options.policy === "current") return current.id;
  if (options.policy === "uniform") {
    // Hash ordering is deterministic and independent of caller array order.
    return [...descriptors].sort((a, b) => evolutionDigest([options.seed, a.id]).localeCompare(evolutionDigest([options.seed, b.id])))[0]!.id;
  }
  if (options.policy !== "development-diversity") throw new Error("unknown archive study policy");
  // Predeclared lexicographic policy: newly solved cases first, then overall
  // fitness. Retains stepping stones without implying promotion eligibility.
  const novel = (entry: typeof current) => [...entry.solved].filter(id => !current.solved.has(id)).length;
  return [...descriptors].sort((a, b) => novel(b) - novel(a) || b.solved.size - a.solved.size || a.id.localeCompare(b.id))[0]!.id;
}
