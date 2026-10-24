import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { campaignValidationBudget } from "./campaign-validation-budget.js";
import { createOrLoadEvolutionCampaign, reserveCampaignDispatch, settleCampaignDispatch, type EvolutionComparisonIdentity } from "./safety.js";
import type { EvolutionConfig } from "./types.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(modelBudget = 10, evaluationBudget = 10) {
 const root = mkdtempSync(join(tmpdir(), "0-validation-budget-")); roots.push(root);
 const digest = "sha256:" + createHash("sha256").update("synthetic-budget-controller-fixture").digest("hex");
 const corpus = { digest, cases: 1 };
 const identity: EvolutionComparisonIdentity = { schemaVersion: 1, development: corpus, heldOut: corpus, negativeControl: corpus, evaluatorDigest: digest, evaluatorSemantics: digest, requestedModel: "fixture", resolvedModel: "fixture", provider: "fixture", harnessRevision: digest, toolRevision: digest, sourceRevision: digest, evaluatedWorker: { kind: "deterministic" }, compatibilityStatus: "compatible" };
 createOrLoadEvolutionCampaign(root, identity, "bounded", { maxModelCostUsd: modelBudget, maxEvaluationCostUsd: evaluationBudget });
 return { storePath: root, maxModelCostUsd: modelBudget, maxModelTurns: 2, cases: [{}, {}, {}], repeats: 2, canaryTrials: 1, timeoutMs: 1000, computeUsdPerSecond: 0.1, safety: { enabled: true, holdoutExposureLimit: 100, workerModel: { provider: "fixture", model: "fixture", maxCostUsdPerExecution: 0.1 } } } as EvolutionConfig;
}
it("keeps complete baseline/candidate plus canary capacity out of proposal spending", () => {
 const config = fixture();
 const budget = campaignValidationBudget(config);
 expect(budget.executions).toBe(24); expect(budget.computeUsd).toBeCloseTo(2.4); expect(budget.workerUsd).toBeCloseTo(2.4); expect(budget.proposalUsd).toBeCloseTo(7.6);
 const reservation = reserveCampaignDispatch(config.storePath, "model", 1);
 expect(campaignValidationBudget(config).proposalUsd).toBeCloseTo(6.6);
 settleCampaignDispatch(config.storePath, reservation.id, 0.25);
 expect(campaignValidationBudget(config).proposalUsd).toBeCloseTo(7.35);
});
it("stops before proposing when a complete bounded validation cannot fit", () => {
 expect(() => campaignValidationBudget(fixture(10, 2))).toThrow(/complete independent validation/);
 expect(() => campaignValidationBudget(fixture(2, 10))).toThrow(/complete worker validation/);
 const config = fixture(); config.cases = Array(1000).fill({});
 expect(() => campaignValidationBudget(config)).toThrow(/dispatch record capacity/);
});
