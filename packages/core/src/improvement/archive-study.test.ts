import { expect, it } from "vitest";
import { selectArchiveStudyParent } from "./archive-study.js";
import type { DevelopmentArchiveObservation } from "./archive-study.js";

function observation(id: string, solved: number[]): DevelopmentArchiveObservation {
  return { id, attempts: [0, 1, 2].flatMap(index => [0, 1].map(repeat => ({
    caseId: `dev-${index}`, repeat, lane: "development" as const, matched: solved.includes(index), inconclusive: false,
  }))) };
}
const options = { policy: "development-diversity" as const, seed: "paired-study-1", currentId: "current", maxCandidates: 3, repeats: 2 };
it("selects a behavior-diverse unsuccessful ancestor without activating it", () => {
  const candidates = [observation("current", [0, 1]), observation("older", [2]), observation("redundant", [0])];
  expect(selectArchiveStudyParent(candidates, options)).toBe("older");
  expect(selectArchiveStudyParent(candidates, { ...options, policy: "current" })).toBe("current");
  expect(selectArchiveStudyParent(candidates, { ...options, policy: "uniform" })).toBe(
    selectArchiveStudyParent([...candidates].reverse(), { ...options, policy: "uniform" }),
  );
});
it("rejects sealed evidence, incomparable corpora and incomplete executions", () => {
  const current = observation("current", [0]);
  const older = observation("older", [1]);
  older.attempts[0]!.lane = "held-out";
  expect(() => selectArchiveStudyParent([current, older], options)).toThrow(/development/);
  older.attempts[0]!.lane = "development";
  older.attempts.pop();
  expect(() => selectArchiveStudyParent([current, older], options)).toThrow(/incomplete/);
  older.attempts.pop();
  expect(() => selectArchiveStudyParent([current, older], options)).toThrow(/corpora/);
});
it("enforces finite archive bounds", () => {
  expect(() => selectArchiveStudyParent([observation("current", [])], { ...options, maxCandidates: 11 })).toThrow(/bounds/);
  expect(() => selectArchiveStudyParent([observation("current", []), observation("older", [])], { ...options, maxCandidates: 1 })).toThrow(/cap/);
});
