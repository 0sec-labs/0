import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evolutionDigest } from "./registry.js";
import { admitSequentialPilotForDiversity, runProposalDiversityStudy, type SequentialPilotEvidence } from "./proposal-diversity-campaign.js";
import { runProposalDiversityControls } from "./proposal-diversity-controls.js";
import { CONTROL_SEARCH_PLAN, createDeterministicSearchStudyAdapter } from "./search-study-controls.js";
function reviewedPilot(): SequentialPilotEvidence {
  const report = { mode: "provider", conclusion: "qualified-for-experiment" as const, protocolDigest: evolutionDigest("reviewed-protocol"), corpusDigest: evolutionDigest("reviewed-corpus"),
    pairedAnalysis: { independentFamilies: 20, interval95: [.01, .2] as [number, number], retentionRegressions: 0, regressionDetected: true },
    cost: { billedUsd: 1, localComputeUsd: .1, unknownUsage: false }, receipts: [
      { identity: { provider: "mock-host-provider", model: "dated-snapshot-2026-01-01", responseModel: "dated-snapshot-2026-01-01", modelVersionStatus: "pinned" as const, decoding: { temperature: 0, seed: 120 } } },
    ] };
  return { report, reportDigest: evolutionDigest(report), reviewRef: "mock-independent-review-only", minimumIndependentFamilies: 10 };
}
describe("same-parent proposal width experiment", () => {
  it("retains width one after a reproducible equal-budget null control", async () => {
    const result = await runProposalDiversityControls();
    expect(result.report.trials).toHaveLength(8);
    expect(new Set(result.report.trials.map(trial => trial.parentId)).size).toBe(1);
    expect(result.report.comparison.every(arm => arm.pairedMeanQualityDelta === 0)).toBe(true);
    expect(result.report.comparison[0]!.knownSpendUsd).toBe(result.report.comparison[1]!.knownSpendUsd);
    expect(result.report.trials.every(trial => trial.knownSpendUsd <= .2 && trial.duplicates === 1 && trial.rejected === 1)).toBe(true);
    expect(result.concurrency).toBe(1);
    expect(result.combinedPatches).toBe(false);
    expect(result.report.decision).toBe("retain-default");
  });
  it("stops the entire width experiment on unknown usage", async () => {
    const result = await runProposalDiversityControls("inconclusive");
    expect(result.report.trials[0]!.proposals).toBe(1);
    expect(result.report.trials.slice(1).every(trial => trial.proposals === 0)).toBe(true);
    expect(result.report.comparison.every(arm => arm.inconclusives === 4)).toBe(true);
  });
  it("requires actual invoices, positive basic-pilot evidence, independent review and pinned runtime", () => {
    expect(() => admitSequentialPilotForDiversity(reviewedPilot())).not.toThrow();
    for (const mutate of [
      (e: SequentialPilotEvidence) => { e.report.mode = "controls"; },
      (e: SequentialPilotEvidence) => { e.report.conclusion = "inconclusive"; },
      (e: SequentialPilotEvidence) => { e.report.cost.billedUsd = null; },
      (e: SequentialPilotEvidence) => { e.report.cost.localComputeUsd = null; },
      (e: SequentialPilotEvidence) => { e.report.cost.unknownUsage = true; },
      (e: SequentialPilotEvidence) => { e.report.pairedAnalysis.interval95[0] = 0; },
      (e: SequentialPilotEvidence) => { e.report.pairedAnalysis.independentFamilies = 1; },
      (e: SequentialPilotEvidence) => { e.report.pairedAnalysis.retentionRegressions = 1; },
      (e: SequentialPilotEvidence) => { e.report.pairedAnalysis.regressionDetected = false; },
      (e: SequentialPilotEvidence) => { e.report.receipts[0]!.identity.modelVersionStatus = "floating"; },
      (e: SequentialPilotEvidence) => { e.report.receipts[0]!.identity.decoding.temperature = NaN; },
    ]) {
      const evidence = reviewedPilot(); mutate(evidence); evidence.reportDigest = evolutionDigest(JSON.parse(JSON.stringify(evidence.report)));
      // NaN is also rejected by canonical JSON before admission.
      expect(() => admitSequentialPilotForDiversity(evidence)).toThrow();
    }
  });
  it("does not dispatch without a qualified pilot and an explicit sufficient spend cap", async () => {
    const pilot = reviewedPilot(); pilot.report.cost.billedUsd = null; pilot.reportDigest = evolutionDigest(pilot.report);
    let dispatches = 0;
    const adapter = createDeterministicSearchStudyAdapter();
    const original = adapter.propose; adapter.propose = async request => { dispatches++; return original(request); };
    const options = { plan: CONTROL_SEARCH_PLAN, qualifiedPilot: pilot, approvedBudgetUsd: 8, width: 3 as const, parentId: "same-parent", feedback: "Fixed development feedback", adapter };
    await expect(runProposalDiversityStudy(options)).rejects.toThrow(/reconciled/);
    await expect(runProposalDiversityStudy({ ...options, qualifiedPilot: reviewedPilot(), approvedBudgetUsd: 1 })).rejects.toThrow(/cap/);
    await expect(runProposalDiversityStudy({ ...options, qualifiedPilot: reviewedPilot(), plan: { ...CONTROL_SEARCH_PLAN, maxProposals: 2 } })).rejects.toThrow(/cohort/);
    expect(dispatches).toBe(0);
    const complete = await runProposalDiversityStudy({ ...options, qualifiedPilot: reviewedPilot() });
    expect(complete.report.trials).toHaveLength(8);
    expect(complete.maximumTotalSpendUsd).toBe(8);
  });
  it("reproduces the committed null and inconclusive controller artifacts", async () => {
    for (const mode of ["null", "inconclusive"] as const) {
      const expected = JSON.parse(readFileSync(new URL(`../../../../docs/qualification/controls/diversity/${mode}.json`, import.meta.url), "utf8"));
      expect(await runProposalDiversityControls(mode)).toEqual(expected);
    }
  });
});
