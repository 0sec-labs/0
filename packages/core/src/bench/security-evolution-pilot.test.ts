import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "./manifest.js";
import { estimateEvolutionExecutions, preflightSecurityPilot, runSecurityEvolutionPilot, type PilotIdentity, type PilotPlan, type PilotScan } from "./security-evolution-pilot.js";
const d = `sha256:${"a".repeat(64)}`;
const identity: PilotIdentity = { provider: "fixture", resolvedModel: "fixture-v1", modelVersionStatus: "pinned", sourceDigest: d, imageDigest: d, evaluatorDigest: d, decodingDigest: d, harnessDigest: d };
const plan: PilotPlan = { schemaVersion: 1, objective: "quality", arms: ["frozen-baseline", "sequential", "aa", "regression"], repeats: 2, maxWorkerExecutions: 30, totalBudgetUsd: 10, perExecutionCeilingUsd: .1, finalValidationExecutions: 6, finalValidationBudgetUsd: 1, maxTurns: 8, protocolRef: "operator-protocol-v1" };
const manifest = parseManifest({ id: "fixture", cases: ["positive", "fixed", "clean"].map(id => ({ id, knownNegative: id !== "positive", target: { kind: "web", image: "fixture", port: 80 }, objective: { type: "file-read", marker: "fixture-proof" } })) });
const labels = { positive: { family: "fixture-family", control: "vulnerable" as const }, fixed: { family: "fixture-family", control: "fixed" as const }, clean: { family: "clean-family", control: "clean" as const } };
const searchCharges = { "frozen-baseline": [], sequential: [{ id: "rejected-proposal", category: "proposal" as const, actualUsd: .3 }], aa: [], regression: [] };
const scan: PilotScan = async input => ({ identity, invariants: { authorityPreserved: true, evidenceValid: true }, modelUsd: .01, computeUsd: .01, report: { findings: input.case.id === "positive" && input.arm !== "regression" ? [{ evidence: { response: "fixture-proof" } }] : [] } });
describe("offline security pilot", () => {
  it("estimates the default 540 workers and reserves a complete final check", () => {
    expect(estimateEvolutionExecutions()).toBe(540);
    expect(estimateEvolutionExecutions(10, 3, 3, 2, 3)).toBe(1620);
    expect(preflightSecurityPilot(plan, 3).plannedExecutions).toBe(24);
    expect(() => preflightSecurityPilot({ ...plan, maxWorkerExecutions: 29 }, 3)).toThrow(/reserved final/);
    expect(() => preflightSecurityPilot({ ...plan, totalBudgetUsd: 3 }, 3)).toThrow(/reserved final/);
  });
  it("keeps ablations gated and separate with no default expansion", () => {
    expect(() => preflightSecurityPilot({ ...plan, arms: [...plan.arms, "summary"] }, 3)).toThrow(/qualified sequential/);
    expect(() => preflightSecurityPilot({ ...plan, arms: [...plan.arms, "summary", "diversity"] }, 3)).toThrow(/separately/);
    expect(() => preflightSecurityPilot({ ...plan, arms: ["sequential"] }, 3)).toThrow(/A\/A/);
  });
  it("uses existing objective oracle, paired repeats, A/A and a deliberate regression", async () => {
    const clock = vi.fn(() => 1000);
    const spy = vi.fn(scan);
    const result = await runSecurityEvolutionPilot({ plan, manifest, labels, scan: spy, searchCharges, now: clock });
    expect(result.status).toBe("completed-for-review");
    expect(result.receipts).toHaveLength(24);
    expect(result.byArm.sequential?.verifiedPositives).toBe(2);
    expect(result.byArm.aa).toEqual(result.byArm["frozen-baseline"]);
    expect(result.byArm.regression?.verifiedPositives).toBe(0);
    expect(result.byArm.sequential?.p95Ms).toBeNull();
    expect(result.knownSpendUsd).toBeCloseTo(.78);
    expect(result.automaticPromotion).toBe(false);
    expect(spy.mock.calls.slice(0, 4).map(([input]) => input.arm)).toEqual(plan.arms);
    expect(spy.mock.calls.every(([input]) => input.ceilingUsd === .1 && input.maxTurns === 8)).toBe(true);
  });
  it("stops after a failed dispatch with unknown billing, never reporting it as zero", async () => {
    const spy = vi.fn(async () => { throw new Error("provider disconnected after dispatch"); });
    const result = await runSecurityEvolutionPilot({ plan, manifest, labels, scan: spy, searchCharges });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("inconclusive");
    expect(result.unknownCharges).toBe(2);
    expect(result.stopReason).toMatch(/reconcile/);
    expect(result.receipts[0].result.status).toBe("inconclusive");
  });
  it("stops on floating model identities and rejects unaccounted search before dispatch", async () => {
    const result = await runSecurityEvolutionPilot({ plan, manifest, labels, scan: async input => ({ ...await scan(input), identity: { ...identity, modelVersionStatus: "floating" } }), searchCharges });
    expect(result.receipts).toHaveLength(1);
    expect(result.stopReason).toMatch(/identity/);
    const spy = vi.fn(scan);
    await expect(runSecurityEvolutionPilot({ plan, manifest, labels, scan: spy, searchCharges: {} })).rejects.toThrow(/accounting missing/);
    expect(spy).not.toHaveBeenCalled();
  });
  it("accounts rejected search and blocks budgets equally across arms", async () => {
    await expect(runSecurityEvolutionPilot({ plan, manifest, labels, scan, searchCharges: { ...searchCharges, sequential: [{ id: "expensive-rejected", category: "proposal", actualUsd: 4 }] } })).rejects.toThrow(/equal search allocation/);
  });
  it("blocks deterministic invariant violations and incompatible paired model provenance", async () => {
    const denied = await runSecurityEvolutionPilot({ plan, manifest, labels, scan: async input => ({ ...await scan(input), invariants: { authorityPreserved: false, evidenceValid: true } }), searchCharges });
    expect(denied.receipts).toHaveLength(1);
    expect(denied.stopReason).toMatch(/invariant/);
    const drift = await runSecurityEvolutionPilot({ plan, manifest, labels, scan: async input => ({ ...await scan(input), identity: { ...identity, resolvedModel: input.arm === "sequential" ? "different-version" : identity.resolvedModel } }), searchCharges });
    expect(drift.receipts).toHaveLength(2);
    expect(drift.stopReason).toMatch(/incompatible runtime/);
  });
  it("requires all independently labelled control kinds", async () => {
    await expect(runSecurityEvolutionPilot({ plan, manifest, labels: { ...labels, clean: { ...labels.clean, control: "fixed" } }, scan, searchCharges })).rejects.toThrow(/fixed and clean/);
  });
});
