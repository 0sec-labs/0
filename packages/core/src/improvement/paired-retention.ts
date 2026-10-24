/** Explicit controller-only, fixed-protocol study analysis. Never dispatches or promotes. */
import { z } from "zod";
import { evolutionDigest } from "./registry.js";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const nonnegative = z.number().finite().nonnegative();
const planSchema = z.object({
  schemaVersion: z.literal(1), profileId: id, profileVersion: z.number().int().positive(),
  protocolDigest: digest, independentFamilySamplingRef: z.string().min(1).max(512),
  comparisonDigest: digest, modelVersionStatus: z.literal("pinned"),
  confidenceAlpha: z.number().gt(0).lt(0.5), minimumIndependentFamilies: z.number().int().min(2).max(10_000),
  maximumRows: z.number().int().min(1).max(50_000), totalCostCeilingUsd: z.number().finite().positive(),
  generations: z.array(z.object({ id, arm: z.enum(["aa", "candidate", "regression-control"]) }).strict()).min(3).max(32),
  capabilities: z.array(z.object({ id, role: z.enum(["retention", "adaptation", "false-positive"]),
    practicalMargin: z.number().min(0).max(1), minimumGain: z.number().min(0).max(1),
  }).strict()).min(3).max(32),
}).strict();
export type PairedRetentionPlan = z.infer<typeof planSchema>;
export interface PairedRetentionObservation {
  generationId: string; capabilityId: string;
  /** Independently curated target/repository/CVE family, never per-repeat IDs. */
  familyDigest: string; pairDigest: string; comparisonDigest: string;
  baseline: { succeeded: boolean; falsePositive: boolean; costUsd: number | null; latencyMs: number | null; executed?: boolean; estimatedCostUsd?: number; billingReceiptDigest?: string };
  candidate: { succeeded: boolean; falsePositive: boolean; costUsd: number | null; latencyMs: number | null; executed?: boolean; estimatedCostUsd?: number; billingReceiptDigest?: string };
  inconclusive: boolean;
  /** Existing deterministic authority/evidence gates remain mandatory. */
  authorityPreserved: boolean; evidenceCorrect: boolean;
}
const percentile = (values: number[], q: number): number | null => values.length >= (q >= 0.95 ? 20 : 2) ? [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1]! : null;
/** Family-clustered Hoeffding intervals with a finite union bound across the
 * preregistered generation×capability panel. Assumes independent curated families;
 * this is not an adaptive/reusable-holdout validity claim or a production gate. */
export function analyzePairedRetention(rawPlan: PairedRetentionPlan, observations: readonly PairedRetentionObservation[]) {
  const plan = planSchema.parse(rawPlan);
  if (new Set(plan.generations.map(v => v.id)).size !== plan.generations.length
    || new Set(plan.capabilities.map(v => v.id)).size !== plan.capabilities.length
    || !["aa", "candidate", "regression-control"].every(arm => plan.generations.some(g => g.arm === arm))
    || !["retention", "adaptation", "false-positive"].every(role => plan.capabilities.some(c => c.role === role))) throw new Error("retention protocol requires unique panels, A/A, candidate and regressing controls");
  if (observations.length > plan.maximumRows) throw new Error("paired retention observation budget exceeded");
  const keys = new Set<string>(); let spentUsd = 0; let estimatedCostUsd = 0; let costUnknown = false;
  for (const entry of observations) {
    const key = `${entry.generationId}:${entry.capabilityId}:${entry.pairDigest}`;
    if (keys.has(key) || !plan.generations.some(g => g.id === entry.generationId) || !plan.capabilities.some(c => c.id === entry.capabilityId)
      || !digest.safeParse(entry.familyDigest).success || !digest.safeParse(entry.pairDigest).success) throw new Error("invalid or replayed paired retention observation");
    keys.add(key);
    for (const side of [entry.baseline, entry.candidate]) {
      if (side.estimatedCostUsd !== undefined) { if (!nonnegative.safeParse(side.estimatedCostUsd).success) throw new Error("invalid estimated execution cost"); estimatedCostUsd += side.estimatedCostUsd; }
      if (side.billingReceiptDigest !== undefined && !digest.safeParse(side.billingReceiptDigest).success) throw new Error("invalid billing receipt reference");
      if (side.costUsd === null || !nonnegative.safeParse(side.costUsd).success) costUnknown = true;
      else spentUsd += side.costUsd;
      if ((side.executed !== undefined && typeof side.executed !== "boolean") || typeof side.succeeded !== "boolean" || typeof side.falsePositive !== "boolean") throw new Error("paired outcomes must be verifier observations");
      if (side.latencyMs !== null && !nonnegative.safeParse(side.latencyMs).success) throw new Error("invalid observed execution latency");
    }
  }
  const contractDigest = evolutionDigest(plan);
  const comparisons = plan.generations.length * plan.capabilities.length;
  const groups = plan.generations.flatMap(generation => plan.capabilities.map(capability => {
    const selected = observations.filter(o => o.generationId === generation.id && o.capabilityId === capability.id);
    const families = new Map<string, number[]>();
    const baselineFamilies = new Map<string, number[]>(), candidateFamilies = new Map<string, number[]>();
    let incomplete = selected.length === 0;
    let invariantFailure = false;
    for (const entry of selected) {
      incomplete ||= entry.baseline.executed === false || entry.candidate.executed === false || entry.inconclusive || entry.comparisonDigest !== plan.comparisonDigest
        || typeof entry.inconclusive !== "boolean" || typeof entry.authorityPreserved !== "boolean" || typeof entry.evidenceCorrect !== "boolean";
      invariantFailure ||= !entry.authorityPreserved || !entry.evidenceCorrect;
      const value = capability.role === "false-positive"
        ? Number(entry.candidate.falsePositive) - Number(entry.baseline.falsePositive)
        : Number(entry.candidate.succeeded) - Number(entry.baseline.succeeded);
      for (const [map, value] of [[baselineFamilies, capability.role === "false-positive" ? Number(entry.baseline.falsePositive) : Number(entry.baseline.succeeded)],
        [candidateFamilies, capability.role === "false-positive" ? Number(entry.candidate.falsePositive) : Number(entry.candidate.succeeded)]] as const) {
        const samples = map.get(entry.familyDigest) ?? []; samples.push(value); map.set(entry.familyDigest, samples);
      }
      const values = families.get(entry.familyDigest) ?? []; values.push(value); families.set(entry.familyDigest, values);
    }
    const values = [...families.values()].map(samples => samples.reduce((a, b) => a + b, 0) / samples.length);
    const n = values.length;
    const familyRate = (map: Map<string, number[]>): number | null => n ? [...map.values()].reduce((sum, rows) => sum + rows.reduce((a, b) => a + b, 0) / rows.length, 0) / n : null;
    const delta = n ? values.reduce((a, b) => a + b, 0) / n : null;
    const radius = n ? Math.sqrt(2 * Math.log(2 * comparisons / plan.confidenceAlpha) / n) : 1;
    const interval: [number, number] = delta === null ? [-1, 1] : [Math.max(-1, delta - radius), Math.min(1, delta + radius)];
    let status: "pass" | "regression" | "inconclusive" = "inconclusive";
    if (invariantFailure) status = "regression";
    else if (!incomplete && !costUnknown && spentUsd <= plan.totalCostCeilingUsd && n >= plan.minimumIndependentFamilies) {
      if (generation.arm === "aa") {
        if (interval[0] >= -capability.practicalMargin && interval[1] <= capability.practicalMargin) status = "pass";
        else if (interval[1] < -capability.practicalMargin || interval[0] > capability.practicalMargin) status = "regression";
      } else if (capability.role === "false-positive") {
        if (interval[1] <= capability.practicalMargin) status = "pass";
        else if (interval[0] > capability.practicalMargin) status = "regression";
      } else if (capability.role === "retention") {
        if (interval[0] >= -capability.practicalMargin) status = "pass";
        else if (interval[1] < -capability.practicalMargin) status = "regression";
      } else {
        if (interval[0] >= capability.minimumGain) status = "pass";
        else if (interval[1] < -capability.practicalMargin) status = "regression";
      }
    }
    return { generationId: generation.id, capabilityId: capability.id, role: capability.role, independentFamilies: n,
      observations: selected.length, baselineRate: familyRate(baselineFamilies), candidateRate: familyRate(candidateFamilies), pairedDelta: delta, confidenceInterval: interval, status };
  }));
  const generations = plan.generations.map(generation => {
    const selected = groups.filter(g => g.generationId === generation.id);
    const status = selected.some(g => g.status === "regression") ? "rejected" : selected.every(g => g.status === "pass") ? "qualified" : "inconclusive";
    return { id: generation.id, arm: generation.arm, status };
  });
  const aaControlPassed = generations.filter(g => g.arm === "aa").every(g => g.status === "qualified");
  const regressingControlDetected = generations.filter(g => g.arm === "regression-control").every(g => g.status === "rejected");
  const latencies = observations.flatMap(o => [o.baseline, o.candidate].filter(side => side.executed !== false).map(side => side.latencyMs)).filter((v): v is number => v !== null);
  return { schemaVersion: 1 as const, contractDigest, evidenceDigest: evolutionDigest(observations), profileId: plan.profileId, profileVersion: plan.profileVersion,
    protocolDigest: plan.protocolDigest, comparisonDigest: plan.comparisonDigest, groups, generations,
    controls: { aaControlPassed, regressingControlDetected,
      aaRejected: generations.filter(g => g.arm === "aa" && g.status === "rejected").length,
      aaInconclusive: generations.filter(g => g.arm === "aa" && g.status === "inconclusive").length,
      candidateInconclusive: generations.filter(g => g.arm === "candidate" && g.status === "inconclusive").length,
    },
    decision: aaControlPassed && regressingControlDetected && generations.filter(g => g.arm === "candidate").every(g => g.status === "qualified") ? "qualified" as const : "not-qualified" as const,
    accounting: { observedCostUsd: spentUsd, estimatedCostUsd, costUnknown, overBudget: spentUsd > plan.totalCostCeilingUsd, workerExecutions: observations.reduce((count, entry) => count + Number(entry.baseline.executed !== false) + Number(entry.candidate.executed !== false), 0),
      latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95), latencySamples: latencies.length },
    limitation: "fixed predeclared independent-family study only; no adaptive-holdout validity, automatic promotion, or empirical benefit claim" };
}
