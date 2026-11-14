import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runHoldoutNullStudy } from "./holdout-null-study.js";

it("reports independently seeded null campaigns with uncertainty and untouched final draws", () => {
  const report = runHoldoutNullStudy();
  for (const arm of report.arms) {
    expect(arm.falseSelection.interval95[0]).toBeLessThanOrEqual(arm.falseSelection.rate);
    expect(arm.falseSelection.interval95[1]).toBeGreaterThanOrEqual(arm.falseSelection.rate);
    expect(arm.finalQueries).toBe(arm.falseSelection.count);
    expect(arm.independentFinalFalsePromotion.count).toBeLessThanOrEqual(arm.finalQueries);
  }
  expect(report.arms[0]!.falseSelection.count).toBeLessThan(report.arms[1]!.falseSelection.count);
  // Reproducibility is a fixture property; the measured rate is never a safety gate.
  expect(runHoldoutNullStudy()).toEqual(report);
  if (process.env.HOLDOUT_NULL_REPORT) writeFileSync(process.env.HOLDOUT_NULL_REPORT, JSON.stringify(report, null, 2) + "\n");
});
