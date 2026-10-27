import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runArchiveStudyControls, createDeterministicSearchStudyAdapter, CONTROL_SEARCH_PLAN } from "./search-study-controls.js";
import { runPairedSearchStudy, validateSearchStudyPlan } from "./paired-search-study.js";
const arms = ["current", "uniform"].map(id => ({ id, parentId: () => "current", width: 1, feedback: "Fixed development feedback" }));
describe("paired fixed-budget search study", () => {
  it("reproduces the committed A/A and regressing controller reports", async () => {
    for (const mode of ["aa", "regression"] as const) {
      const committed = JSON.parse(readFileSync(new URL(`../../../../docs/qualification/controls/archive/${mode}.json`, import.meta.url), "utf8"));
      expect(await runArchiveStudyControls(mode)).toEqual(committed);
    }
  });
  it("reports repeated paired A/A outcomes and fully charges equivalent/rejected edits", async () => {
    const control = await runArchiveStudyControls();
    expect(control.report.trials).toHaveLength(12);
    for (const trial of control.report.trials) {
      expect(trial.status).toBe("completed");
      expect(trial.proposals).toBe(4);
      expect(trial.duplicates).toBe(1);
      expect(trial.rejected).toBe(1);
      expect(trial.workerExecutions).toBe(16);
      expect(trial.knownSpendUsd).toBeCloseTo(0.166);
      expect(trial.charges.filter(charge => charge.category === "proposal")).toHaveLength(4);
      expect(trial.elapsedMs).toBeGreaterThan(0);
    }
    expect(control.report.comparison.every(arm => arm.pairedMeanQualityDelta === 0)).toBe(true);
    expect(control.report.automaticPromotion).toBe(false);
    expect(control.report.decision).toBe("retain-default");
    expect(await runArchiveStudyControls()).toEqual(control);
  });
  it("reports attractive aggregate gains that fail retention and negative controls", async () => {
    const control = await runArchiveStudyControls("regression");
    const diverse = control.report.comparison.find(arm => arm.arm === "development-diversity")!;
    expect(diverse.bestQuality).toBe(1);
    expect(diverse.retentionFailures).toBe(4);
    expect(diverse.falsePositives).toBe(4);
    expect(control.report.decision).toBe("retain-default");
  });
  it("rejects insufficient independent final reserve before dispatch", () => {
    expect(() => validateSearchStudyPlan({ ...CONTROL_SEARCH_PLAN, finalReserveUsd: 0.01 }, arms)).toThrow(/reserve/);
    expect(() => validateSearchStudyPlan({ ...CONTROL_SEARCH_PLAN, finalReserveExecutions: 1 }, arms)).toThrow(/reserve/);
  });
  it("stops a campaign immediately on unknown paid usage and preserves rejected costs", async () => {
    const adapter = createDeterministicSearchStudyAdapter();
    let dispatches = 0;
    adapter.propose = async r => { dispatches++; return { value: null, charges: [{ id: `${r.seed}:${r.arm}`, category: "proposal", actualUsd: null }], workerExecutions: 0, retainedBytes: 0, status: "inconclusive" }; };
    const report = await runPairedSearchStudy({ plan: CONTROL_SEARCH_PLAN, arms, adapter });
    expect(dispatches).toBe(1);
    expect(report.trials[0]!.unknownCharges).toBe(1);
    expect(report.trials.slice(1).every(trial => trial.proposals === 0 && trial.final === null)).toBe(true);
    expect(report.comparison.every(arm => arm.inconclusives === 4)).toBe(true);
  });
  it("uses identical parent and feedback within a bounded-width cohort", async () => {
    const requests: Array<{ arm: string; feedback: string; parentId: string }> = [];
    const adapter = createDeterministicSearchStudyAdapter();
    const original = adapter.propose;
    adapter.propose = async r => { requests.push(r); return original(r); };
    await runPairedSearchStudy({ plan: CONTROL_SEARCH_PLAN, arms: arms.map(arm => ({ ...arm, width: 3 })), adapter });
    for (let offset = 0; offset < requests.length; offset += 4) {
      expect(new Set(requests.slice(offset, offset + 3).map(r => r.feedback)).size).toBe(1);
      expect(new Set(requests.slice(offset, offset + 4).map(r => r.parentId)).size).toBe(1);
    }
  });
});
