import { describe, expect, it } from "vitest";
import { evaluateEvolutionRetention, assertEvolutionRetentionContinuity } from "./retention.js";
import type { EvolutionAttempt, EvolutionConfig } from "./types.js";
import { parseEvolutionConfig } from "./config.js";

const config = {
  repeats: 2,
  retentionPolicy: { profileId: "parser-authority", version: 1, criticalCaseIds: ["old-capability", "negative"] },
  cases: [
    { id: "old-capability", lane: "held-out", input: { x: 1 }, expected: { safe: false } },
    { id: "negative", lane: "negative-control", input: { x: 2 }, expected: { safe: true } },
  ],
} as EvolutionConfig;
function attempts(): EvolutionAttempt[] {
  return config.cases.flatMap(fixture => [0, 1].map(repeat => ({
    caseId: fixture.id, lane: fixture.lane, repeat, matched: true, inconclusive: false,
    costUsd: 0, execution: { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1, timedOut: false },
  })));
}
describe("versioned deterministic retention panel", () => {
  it("rejects missing, duplicate and development-only panel cases at config admission", () => {
    const raw = {
      schemaVersion: 1, sourceRoot: "/tmp/source", storePath: "/tmp/evolution-store",
      image: "node:22", sourcePaths: ["src"], editablePaths: ["src"], command: ["node", "src/main.js"],
      computeUsdPerSecond: 0.001, objective: "Preserve critical behavior", promotionPolicy: { minimumCases: 3 },
      cases: ["development", "held-out", "negative-control"].flatMap(lane => [0, 1, 2].map(index => ({
        id: `${lane}-${index}`, lane, input: { lane, index }, expected: { ok: true },
      }))),
    };
    const policy = (ids: string[]) => ({ ...raw, retentionPolicy: { profileId: "critical", version: 1, criticalCaseIds: ids } });
    expect(() => parseEvolutionConfig(policy(["missing"]))).toThrow(/sealed/);
    expect(() => parseEvolutionConfig(policy(["development-0"]))).toThrow(/sealed/);
    expect(() => parseEvolutionConfig(policy(["held-out-0", "held-out-0"]))).toThrow(/duplicate/);
    expect(parseEvolutionConfig(policy(["held-out-0", "negative-control-0"])).retentionPolicy?.version).toBe(1);
  });
  it("retains old critical capabilities even when the current baseline no longer solves them", () => {
    const evidence = attempts();
    expect(evaluateEvolutionRetention(config, evidence).passed).toBe(true);
    evidence[0]!.matched = false;
    const failed = evaluateEvolutionRetention(config, evidence);
    expect(failed.passed).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("old-capability");
  });
  it("requires complete distinct repeats and negative controls", () => {
    const evidence = attempts();
    expect(evaluateEvolutionRetention(config, evidence.slice(1)).passed).toBe(false);
    evidence[1]!.repeat = 0;
    expect(evaluateEvolutionRetention(config, evidence).passed).toBe(false);
    const inconclusive = attempts();
    inconclusive[3]!.inconclusive = true;
    expect(evaluateEvolutionRetention(config, inconclusive).passed).toBe(false);
  });
  it("binds source-independent case contents and panel revisions without relying on labels", () => {
    const original = evaluateEvolutionRetention(config, attempts());
    const renamed = structuredClone(config);
    renamed.cases[0]!.id = "renamed";
    renamed.retentionPolicy!.criticalCaseIds[0] = "renamed";
    expect(evaluateEvolutionRetention(renamed, []).profileDigest).toBe(original.profileDigest);
    renamed.cases[0]!.expected = { safe: true };
    expect(evaluateEvolutionRetention(renamed, []).profileDigest).not.toBe(original.profileDigest);
    const revised = structuredClone(config);
    revised.retentionPolicy!.version++;
    expect(evaluateEvolutionRetention(revised, []).profileDigest).not.toBe(original.profileDigest);
  });
  it("binds cohorts to evaluator/worker provenance and requires explicit approved longitudinal rotation", () => {
    const context = { evaluatorDigest: "sha256:" + "a".repeat(64), comparisonDigest: "sha256:" + "b".repeat(64) };
    const first = evaluateEvolutionRetention(config, attempts(), context);
    const next = structuredClone(config); next.retentionPolicy!.criticalCaseIds.pop();
    const nextReceipt = evaluateEvolutionRetention(next, attempts(), context);
    expect(() => assertEvolutionRetentionContinuity(config.retentionPolicy, first, next.retentionPolicy, nextReceipt)).toThrow(/approved versioned rotation/);
    expect(() => assertEvolutionRetentionContinuity(config.retentionPolicy, first, undefined, undefined)).toThrow(/cannot be disabled/);
    expect(evaluateEvolutionRetention(config, attempts(), { ...context, evaluatorDigest: "sha256:" + "c".repeat(64) }).profileDigest).not.toBe(first.profileDigest);
    next.retentionPolicy!.version = 2; next.retentionPolicy!.previousProfileDigest = first.profileDigest; next.retentionPolicy!.rotationApprovalRef = "operator-reviewed-cohort-rotation";
    expect(() => assertEvolutionRetentionContinuity(config.retentionPolicy, first, next.retentionPolicy, evaluateEvolutionRetention(next, attempts(), context))).not.toThrow();
  });

  it("adds no evidence requirement when the optional panel is disabled", () => {
    expect(evaluateEvolutionRetention({ ...config, retentionPolicy: undefined }, []).passed).toBe(true);
  });
});
