import { evolutionDigest } from "./registry.js";
import type { EvolutionAttempt, EvolutionConfig } from "./types.js";

/** Controller-only deterministic retention panel. No additional worker calls.
 * This exact-output gate is not a statistical policy for stochastic models. */
export function evaluateEvolutionRetention(config: EvolutionConfig, attempts: EvolutionAttempt[]) {
  const policy = config.retentionPolicy;
  if (!policy) return { profileDigest: "", passed: true, checkedCases: 0, reasons: [] as string[] };
  const panel = policy.criticalCaseIds.map(id => {
    const fixture = config.cases.find(entry => entry.id === id);
    if (!fixture || fixture.lane === "development") throw new Error("invalid sealed retention panel");
    return fixture;
  });
  // Bind contents, evaluator protocol and declared panel version. Case renaming
  // alone does not change content identity; labels cannot launder a regression.
  const profileDigest = evolutionDigest({
    profileId: policy.profileId, version: policy.version, protocol: "exact-json-retention-v1",
    cases: panel.map(({ lane, input, expected }) => evolutionDigest({ lane, input, expected })).sort(),
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
  return { profileDigest, passed: reasons.length === 0, checkedCases: panel.length, reasons };
}
