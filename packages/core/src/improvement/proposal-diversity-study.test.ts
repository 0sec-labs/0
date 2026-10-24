import { describe, expect, it } from "vitest";
import { shortlistDiversityStudy, type DiversityStudyPolicy, type DiversityStudyProposal } from "./proposal-diversity-study.js";
const d = `sha256:${"a".repeat(64)}`;
const policy: DiversityStudyPolicy = { qualifiedPilotRef: "qualified-study-v1", proposalWidth: 3, maxConcurrency: 1, maxRetainedBytes: 4096, parentDigest: d, editablePaths: ["src/a.ts"], feedbackDigest: d, totalBudgetUsd: 10, finalValidationBudgetUsd: 2, maxWorkerExecutions: 100, finalValidationExecutions: 40 };
const proposal = (id: string, content: string): DiversityStudyProposal => ({ id, parentDigest: d, feedbackDigest: d, hypothesis: "bounded hypothesis", targetedFailureRef: "dev-receipt", risk: "possible regression", edits: [{ path: "src/a.ts", beforeDigest: d, content }], screen: { lane: "development", score: .6 }, actualSearchUsd: 1, workerExecutions: 10 });
describe("conditional proposal diversity", () => {
  it("charges equivalent and rejected edits, shortlists one candidate and never combines", () => {
    const result = shortlistDiversityStudy(policy, [proposal("a", "change"), proposal("b", "change"), { ...proposal("c", "second"), screen: { lane: "development", score: .8 } }]);
    expect(result.selectedId).toBe("c");
    expect(result.rejected).toEqual([{ id: "b", reason: "equivalent edit" }]);
    expect(result.actualSearchUsd).toBe(3);
    expect(result.workerExecutions).toBe(30);
    expect(result.requiresIndependentValidation).toBe(true);
  });
  it("rejects changed parent/feedback and edits outside the fixed surface", () => {
    const result = shortlistDiversityStudy(policy, [{ ...proposal("a", "change"), parentDigest: "other" }, { ...proposal("b", "change"), edits: [{ path: "../secret", beforeDigest: null, content: "bad" }] }]);
    expect(result.selectedId).toBeNull();
    expect(result.rejected).toHaveLength(2);
    expect(result.actualSearchUsd).toBe(2);
  });
  it("stops on unknown costs, capacity exhaustion and an unqualified pilot", () => {
    expect(() => shortlistDiversityStudy(policy, [{ ...proposal("a", "change"), actualSearchUsd: null }])).toThrow(/unknown/);
    expect(() => shortlistDiversityStudy(policy, [{ ...proposal("a", "change"), actualSearchUsd: 9 }])).toThrow(/reserved/);
    expect(() => shortlistDiversityStudy(policy, [{ ...proposal("a", "change"), workerExecutions: 70 }])).toThrow(/reserved/);
    expect(() => shortlistDiversityStudy({ ...policy, qualifiedPilotRef: "" }, [])).toThrow(/qualified/);
    expect(() => shortlistDiversityStudy({ ...policy, maxRetainedBytes: 1 }, [proposal("a", "change")])).toThrow(/retention bound/);
  });
});
