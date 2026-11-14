import { expect, it } from "vitest";
import { createCostBudgetWarnings } from "./cost-budget-warning.js";
it("warns at $40 and $45 of a $50 limit once each", () => {
  const warn = createCostBudgetWarnings(50);
  expect(warn(39.99)).toEqual([]);
  expect(warn(40).map(w => w.stage)).toEqual(["soft"]);
  expect(warn(44)).toEqual([]);
  expect(warn(45).map(w => w.stage)).toEqual(["hard"]);
  expect(warn(49)).toEqual([]);
});
it("emits both in order if a request crosses both thresholds", () => {
  const warn = createCostBudgetWarnings(1);
  expect(warn(0.95).map(w => w.stage)).toEqual(["soft", "hard"]);
  expect(warn(0.95)).toEqual([]);
});
it("does not suggest another turn after the ceiling or with unknown cost", () => {
  for (const spent of [50, 51, NaN, Infinity, -1]) expect(createCostBudgetWarnings(50)(spent)).toEqual([]);
});
it("does not substitute budget pressure for evidence", () => {
  const messages = createCostBudgetWarnings(50)(46).map(w => w.message).join(" ");
  expect(messages).toContain("keep unverified issues");
  expect(messages).toContain("Do not claim clean or complete coverage");
});
