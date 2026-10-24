import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { wilson95 } from "../bench/scorecard.js";
import { describe, expect, it } from "vitest";
import { analyzePairedRetention, type PairedRetentionObservation, type PairedRetentionPlan } from "./paired-retention.js";
const hash = (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex");
const plan: PairedRetentionPlan = {
  schemaVersion: 1, profileId: "synthetic-critical-panel", profileVersion: 1, protocolDigest: hash("predeclared-protocol"),
  independentFamilySamplingRef: "fixture-only-independent-generative-families", comparisonDigest: hash("pinned-worker-and-evaluator"), modelVersionStatus: "pinned",
  confidenceAlpha: 0.05, minimumIndependentFamilies: 200, maximumRows: 4000, totalCostCeilingUsd: 1,
  generations: [{ id: "aa", arm: "aa" }, { id: "generation-2", arm: "candidate" }, { id: "regressor", arm: "regression-control" }],
  capabilities: [{ id: "old-critical", role: "retention", practicalMargin: 0.2, minimumGain: 0 },
    { id: "new-capability", role: "adaptation", practicalMargin: 0.2, minimumGain: 0.1 },
    { id: "safe-controls", role: "false-positive", practicalMargin: 0.2, minimumGain: 0 }],
};
function fixture(): PairedRetentionObservation[] {
  return plan.generations.flatMap(generation => plan.capabilities.flatMap(capability => Array.from({ length: 400 }, (_, index) => {
    const old = index % 4 < 3;
    const adaptation = capability.role === "adaptation" && generation.arm !== "aa";
    const regressing = capability.role === "retention" && generation.arm === "regression-control";
    return { generationId: generation.id, capabilityId: capability.id, familyDigest: hash(`family-${index}`), pairDigest: hash(`${generation.id}-${capability.id}-${index}`),
      comparisonDigest: plan.comparisonDigest, baseline: { succeeded: adaptation ? index % 4 === 0 : old, falsePositive: false, costUsd: 0.00001, latencyMs: 10 },
      candidate: { succeeded: adaptation ? index % 4 < 3 : regressing ? index % 4 === 0 : old, falsePositive: false, costUsd: 0.00001, latencyMs: 12 },
      inconclusive: false, authorityPreserved: true, evidenceCorrect: true };
  })));
}
describe("fixed-protocol paired longitudinal retention study", () => {
  it("separates retention, adaptation and false alarms, qualifies A/A and detects deliberate forgetting", () => {
    const report = analyzePairedRetention(plan, fixture());
    expect(report.controls).toMatchObject({ aaControlPassed: true, regressingControlDetected: true, aaRejected: 0, aaInconclusive: 0 });
    expect(report.generations.find(g => g.id === "generation-2")?.status).toBe("qualified");
    expect(report.generations.find(g => g.id === "regressor")?.status).toBe("rejected");
    expect(report.groups.find(g => g.generationId === "regressor" && g.role === "adaptation")?.status).toBe("pass");
    expect(report.accounting).toMatchObject({ workerExecutions: 7200, costUnknown: false, overBudget: false, latencyP50Ms: 10, latencyP95Ms: 12 });
    expect(report.accounting.observedCostUsd).toBeCloseTo(0.072);
    expect(JSON.stringify(report)).not.toContain("family-");
    if (process.env.ZERO_RETENTION_REPORT) { mkdirSync(dirname(process.env.ZERO_RETENTION_REPORT), { recursive: true }); writeFileSync(process.env.ZERO_RETENTION_REPORT, JSON.stringify({ ...report, evidenceKind: "deterministic-synthetic-controls-not-paid-security-benefit" }, null, 2) + "\n"); }
  });
  it("reports seeded stochastic A/A controls with uncertainty instead of asserting optimizer benefit", () => {
    let falseRejections = 0, aaInconclusive = 0, regressorsDetected = 0, qualified = 0;
    const durations: number[] = [];
    for (let seed = 1; seed <= 32; seed++) {
      let state = seed * 2654435761;
      const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
      const rows = fixture().map(row => {
        const role = plan.capabilities.find(c => c.id === row.capabilityId)!.role;
        const arm = plan.generations.find(g => g.id === row.generationId)!.arm;
        const baselineRate = role === "adaptation" ? 0.25 : 0.75;
        const candidateRate = arm === "aa" ? baselineRate : role === "adaptation" ? 0.75 : arm === "regression-control" && role === "retention" ? 0.25 : baselineRate;
        return { ...row, baseline: { ...row.baseline, succeeded: random() < baselineRate, falsePositive: random() < 0.01 },
          candidate: { ...row.candidate, succeeded: random() < candidateRate, falsePositive: random() < 0.01 } };
      });
      const started = performance.now(); const report = analyzePairedRetention(plan, rows); durations.push(performance.now() - started);
      falseRejections += report.controls.aaRejected; aaInconclusive += report.controls.aaInconclusive;
      regressorsDetected += Number(report.controls.regressingControlDetected); qualified += Number(report.decision === "qualified");
    }
    durations.sort((a, b) => a - b);
    const report = { schemaVersion: 1, evidenceKind: "seeded-synthetic-stochastic-controls-not-model-benefit", independentSeeds: 32,
      familiesPerPanel: 400, familyIndependenceAssumption: "synthetically generated independent families", comparisonsPerStudy: 9,
      confidenceAlpha: plan.confidenceAlpha, practicalMargins: plan.capabilities.map(c => ({ role: c.role, margin: c.practicalMargin })),
      aaFalseRejections: falseRejections, aaFalseRejectionRateCI95: wilson95(falseRejections, 32), aaInconclusive,
      regressingControlsDetected: regressorsDetected, regressingControlDetectionRateCI95: wilson95(regressorsDetected, 32),
      qualifiedStudies: qualified, analysisP50Ms: durations[15], analysisP95Ms: durations[30],
      modelCalls: 0, actualProviderSpendUsd: 0,
      limitation: "32 synthetic seeded studies test policy behavior and uncertainty; they do not establish security effect sizes or adaptive-holdout validity" };
    expect(falseRejections + aaInconclusive).toBeLessThanOrEqual(32);
    expect(report.aaFalseRejectionRateCI95[1]).toBeGreaterThan(0);
    if (process.env.ZERO_RETENTION_NULL_REPORT) { mkdirSync(dirname(process.env.ZERO_RETENTION_NULL_REPORT), { recursive: true }); writeFileSync(process.env.ZERO_RETENTION_NULL_REPORT, JSON.stringify(report, null, 2) + "\n"); }
  });

  it("never qualifies explicit unexecuted observations regardless claimed success and zero charges", () => {
    const rows = fixture().map(row => ({ ...row, baseline: { ...row.baseline, executed: false, costUsd: 0 }, candidate: { ...row.candidate, executed: false, costUsd: 0 } }));
    const report = analyzePairedRetention(plan, rows);
    expect(report.decision).toBe("not-qualified");
    expect(report.groups.every(group => group.status === "inconclusive")).toBe(true);
    expect(report.accounting.workerExecutions).toBe(0);
    expect(report.accounting.latencySamples).toBe(0);
    expect(report.accounting.latencyP95Ms).toBeNull();
  });

  it("does not turn correlated repeats into independent evidence", () => {
    const rows = fixture().map(row => ({ ...row, familyDigest: hash("one-correlated-family") }));
    const report = analyzePairedRetention(plan, rows);
    expect(report.decision).toBe("not-qualified");
    expect(report.groups.every(group => group.independentFamilies === 1 && group.status === "inconclusive")).toBe(true);
  });
  it.each(["interrupted", "unknown-charge", "over-budget", "changed-evaluator"])("never manufactures a pass for %s evidence", kind => {
    const rows = fixture();
    if (kind === "interrupted") rows[0]!.inconclusive = true;
    if (kind === "unknown-charge") rows[0]!.candidate.costUsd = null;
    if (kind === "changed-evaluator") rows[0]!.comparisonDigest = hash("other-evaluator");
    const report = analyzePairedRetention({ ...plan, totalCostCeilingUsd: kind === "over-budget" ? 0.001 : 1 }, rows);
    expect(report.decision).toBe("not-qualified");
  });
  it("preserves deterministic authority/evidence gates and rejects receipt replay", () => {
    const rows = fixture(); rows[400]!.evidenceCorrect = false;
    expect(analyzePairedRetention(plan, rows).groups.find(g => g.generationId === "aa" && g.role === "adaptation")?.status).toBe("regression");
    expect(() => analyzePairedRetention(plan, [...fixture(), fixture()[0]!])).toThrow(/replayed/);
    expect(() => analyzePairedRetention({ ...plan, modelVersionStatus: "floating" as "pinned" }, fixture())).toThrow();
    expect(() => analyzePairedRetention({ ...plan, maximumRows: 1 }, fixture())).toThrow(/budget/);
  });
});
