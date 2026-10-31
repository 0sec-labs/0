import { evolutionDigest } from "./registry.js";
import type { EvolutionAttempt, EvolutionConfig } from "./types.js";

/** Controller-only deterministic retention panel. No additional worker calls.
 * This exact-output gate is not a statistical policy for stochastic models. */
export function evaluateEvolutionRetention(config: EvolutionConfig, attempts: EvolutionAttempt[], context?: { evaluatorDigest: string; comparisonDigest: string }) {
  const policy = config.retentionPolicy;
  if (!policy) return { profileDigest: "", profileId: null as string | null, profileVersion: 0, cohortDigest: null as string | null, evaluatorDigest: null as string | null, comparisonDigest: null as string | null, passed: true, checkedCases: 0, reasons: [] as string[] };
  const panel = policy.criticalCaseIds.map(id => {
    const fixture = config.cases.find(entry => entry.id === id);
    if (!fixture || fixture.lane === "development") throw new Error("invalid sealed retention panel");
    return fixture;
  });
  // Bind contents, evaluator protocol and declared panel version. Case renaming
  // alone does not change content identity; labels cannot launder a regression.
  const cohortDigest = evolutionDigest(panel.map(({ lane, input, expected }) => evolutionDigest({ lane, input, expected })).sort());
  const profileDigest = evolutionDigest({
    profileId: policy.profileId, version: policy.version, protocol: "exact-json-retention-v1",
    cohortDigest, evaluatorDigest: context?.evaluatorDigest ?? null, comparisonDigest: context?.comparisonDigest ?? null,
  });
  const reasons: string[] = [];
  for (const fixture of panel) {
    const selected = attempts.filter(entry => entry.caseId === fixture.id && entry.lane === fixture.lane);
    const repeats = new Set(selected.map(entry => entry.repeat));
    if (selected.length !== config.repeats || repeats.size !== config.repeats
      || selected.some(entry => !Number.isInteger(entry.repeat) || entry.repeat < 0 || entry.repeat >= config.repeats
        || entry.inconclusive || !entry.matched)) {
      // Do not publish sealed identities or per-case outcomes in summaries.
      reasons.push("critical capability missing, inconclusive, or regressed");
    }
  }
  return { profileDigest, profileId: policy.profileId as string | null, profileVersion: policy.version, cohortDigest: cohortDigest as string | null, evaluatorDigest: context?.evaluatorDigest ?? null, comparisonDigest: context?.comparisonDigest ?? null, passed: reasons.length === 0, checkedCases: panel.length, reasons };
}

/** The current baseline's named panel cannot silently disappear between generations. */
export function assertEvolutionRetentionContinuity(
  previousPolicy: EvolutionConfig["retentionPolicy"], previous: ReturnType<typeof evaluateEvolutionRetention> | undefined,
  currentPolicy: EvolutionConfig["retentionPolicy"], current: ReturnType<typeof evaluateEvolutionRetention> | undefined,
  initialDeclared?: { previous: string; current: string },
): void {
  if (!previousPolicy) return;
  if (!currentPolicy || !current?.passed) throw new Error("existing critical retention policy cannot be disabled or left incomplete");
  const priorDigest = previous?.profileDigest ?? initialDeclared?.previous;
  if (!priorDigest) throw new Error("prior declared retention cohort identity is unavailable");
  if (previous?.profileDigest ? previous.profileDigest === current.profileDigest : initialDeclared?.previous === initialDeclared?.current) return;
  if (currentPolicy.profileId !== previousPolicy.profileId || currentPolicy.version <= previousPolicy.version
    || currentPolicy.previousProfileDigest !== priorDigest || !currentPolicy.rotationApprovalRef?.trim()) {
    throw new Error("retention profile/cohort/evaluator changed without an approved versioned rotation");
  }
}

/** Fingerprint an initial declared panel before any evaluation evidence exists. */
export function declaredEvolutionRetentionProfileDigest(config: EvolutionConfig): string {
  return evaluateEvolutionRetention(config, []).profileDigest;
}
