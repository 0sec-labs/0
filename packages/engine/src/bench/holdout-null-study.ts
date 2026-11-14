import { createHash } from "node:crypto";

interface Rate { count: number; total: number; rate: number; interval95: [number, number] }
function rate(count: number, total: number): Rate {
  const p = count / total, z = 1.959963984540054, d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return { count, total, rate: p, interval95: [Math.max(0, center - half), Math.min(1, center + half)] };
}
function random(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE();
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
function successes(rng: () => number, size: number): number {
  let count = 0;
  for (let i = 0; i < size; i++) if (rng() < 0.5) count++;
  return count;
}
/** Synthetic A/A null only: a finite query budget limits opportunity, not generalization error. */
export function runHoldoutNullStudy(campaigns = 2000) {
  if (!Number.isSafeInteger(campaigns) || campaigns < 100 || campaigns > 100_000) throw new Error("campaign count must be 100..100000");
  const panelSize = 64, threshold = 40, budgets = [4, 32];
  return {
    schemaVersion: 1, protocol: "independent-seed-null-v1", campaigns, panelSize, threshold,
    nullTruth: "All candidates have true success probability 0.5; no capability gain exists.",
    limits: "Synthetic simulation, not production-gate calibration or an adaptive-validity guarantee. Correlated real tasks and stochastic workers require the separate paid qualification protocol.",
    arms: budgets.map(budget => {
      let selected = 0, finalPassed = 0;
      for (let seed = 0; seed < campaigns; seed++) {
        const selection = random(`null-campaign-${seed}-selection`);
        let best = -1;
        for (let query = 0; query < budget; query++) best = Math.max(best, successes(selection, panelSize));
        if (best < threshold) continue;
        selected++;
        // The independent final RNG is not created or queried until selection
        // has irrevocably finished; no final score can choose a candidate.
        const final = random(`null-campaign-${seed}-independent-final`);
        if (successes(final, panelSize) >= threshold) finalPassed++;
      }
      return { selectionQueryBudget: budget, falseSelection: rate(selected, campaigns),
        independentFinalFalsePromotion: rate(finalPassed, campaigns), finalQueries: selected };
    }),
  };
}
