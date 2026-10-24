import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseEvolutionConfig } from "./config.js";
import { evolutionDigest, evolutionSourceRevision, snapshotEvolutionSource } from "./registry.js";
import { evolutionEvaluatorDigest } from "./evaluation.js";
import { loadEvolutionCampaign } from "./safety.js";
import { createModelSearchStudyAdapter } from "./search-study-model-adapter.js";
import { runPairedSearchStudy } from "./paired-search-study.js";
import type { EvolutionDependencies } from "./types.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  const unlock = (path: string) => { chmodSync(path, 0o700); for (const item of readdirSync(path, { withFileTypes: true })) if (item.isDirectory()) unlock(join(path, item.name)); };
  for (const root of roots.splice(0)) { unlock(root); rmSync(root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "search-study-adapter-")); roots.push(root);
  vi.stubEnv("ZERO_EVOLUTION_AUTHORITY_ROOT", join(root, "authority"));
  const sourceRoot = join(root, "source"); mkdirSync(join(sourceRoot, "src"), { recursive: true });
  writeFileSync(join(sourceRoot, "src/parser.cjs"), "module.exports = 1;\n");
  const config = (scope: string) => parseEvolutionConfig({ schemaVersion: 1, sourceRoot, storePath: join(root, scope),
    image: "node:22-alpine", sourcePaths: ["src"], editablePaths: ["src/parser.cjs"], command: ["node", "src/parser.cjs"],
    computeUsdPerSecond: .001, timeoutMs: 100, repeats: 2, maxSourceBytes: 4096, maxChangedBytes: 1024,
    allowModelSourceAccess: true, model: "anthropic/claude-sonnet-4-6", objective: "Improve parser detection", maxOutputBytes: 1024,
    promotionPolicy: { minimumCases: 3 }, safety: { enabled: true, holdoutExposureLimit: 100 },
    cases: ["development", "held-out", "negative-control"].flatMap(lane => [0, 1, 2].map(index => ({
      id: `${scope}-${lane}-${index}`, lane, input: { scope, lane, index }, expected: { unsafe: lane !== "negative-control" },
    }))),
  });
  const searchConfig = config("search"); const finalConfig = config("FINAL-ONLY-SECRET");
  finalConfig.retentionPolicy = { profileId: "critical-parser", version: 1, criticalCaseIds: ["FINAL-ONLY-SECRET-held-out-0", "FINAL-ONLY-SECRET-negative-control-0"] };
  const baseline = await snapshotEvolutionSource(searchConfig); const file = baseline.files[0]!;
  let calls = 0;
  const dependencies: EvolutionDependencies = {
    modelIdentity: () => ({ provider: "anthropic", model: "claude-sonnet-4-6", pricingModel: "anthropic/claude-sonnet-4-6" }),
    model: async system => {
      calls++; expect(system).not.toContain("FINAL-ONLY-SECRET");
      expect(system).not.toContain("search-held-out");
      return { content: [{ type: "tool_use", id: "proposal", name: "propose_edits", input: { rationale: "Repair parser", edits: [{ path: file.path, beforeDigest: file.digest, content: "module.exports = 2;\n" }] } }], stopReason: "tool_use", usage: { inputTokens: 1000, outputTokens: 100 }, durationMs: 1 };
    },
    sandbox: async ({ snapshot, input }) => {
      const value = input as { lane: string; index: number };
      const detects = snapshot.id !== baseline.id || value.index !== 2;
      return { exitCode: 0, stdout: JSON.stringify({ unsafe: value.lane !== "negative-control" && detects }), stderr: "", durationMs: 1, timedOut: false };
    },
  };
  const identity = { provider: "anthropic", resolvedModel: "claude-sonnet-4-6", modelVersionStatus: "pinned" as const,
    sourceDigest: evolutionSourceRevision(searchConfig), imageDigest: evolutionDigest("mock-trusted-image"), evaluatorDigest: evolutionEvaluatorDigest(), decodingDigest: evolutionDigest("mock-decoding"), harnessDigest: baseline.digest };
  return { searchConfig, finalConfig, baseline, dependencies, identity, proposalDependencies: () => dependencies, observeBilling: async (_request: unknown, _phase: unknown, estimatedUsd: number) => ({ actualUsd: estimatedUsd, receiptDigest: evolutionDigest(["mock-observed-bill", estimatedUsd]) }), calls: () => calls };
}
it("connects the study to existing metered proposal/snapshot/evaluation APIs without disclosing the final set", async () => {
  const f = await fixture();
  const adapter = createModelSearchStudyAdapter({ ...f, parents: new Map([[f.baseline.id, f.baseline]]) });
  expect(f.calls()).toBe(0);
  const report = await runPairedSearchStudy({ adapter,
    plan: { schemaVersion: 1, protocolRef: "mock-integration-control", seeds: ["one", "two"], armBudgetUsd: .5, maxWorkerExecutions: 60,
      maxProposals: 2, maxRetainedBytes: 262144, finalReserveUsd: .01, finalReserveExecutions: 36,
      ceilings: { proposal: .1, build: .01, development: .01, final: .01 }, developmentExecutions: 6, finalExecutions: 36 },
    arms: ["current", "aa"].map(id => ({ id, parentId: () => f.baseline.id, width: 1, feedback: "Development-only parser miss" })),
  });
  expect(report.trials.map(trial => ({ status: trial.status, reason: trial.reason }))).toEqual(report.trials.map(() => ({ status: "completed", reason: null })));
  expect(report.trials.every(trial => trial.final!.verifiedQuality === 1)).toBe(true);
  expect(report.trials.every(trial => trial.duplicates === 1 && trial.knownSpendUsd > .009)).toBe(true);
  expect(report.trials.every(trial => trial.unknownCharges === 0 && trial.workerExecutions === 42)).toBe(true);
  expect(f.calls()).toBe(8);
  expect(loadEvolutionCampaign(f.finalConfig.storePath).exposures[0]?.consumed).toBe(96);
});
it("refuses overlapping final inputs before any provider dispatch", async () => {
  const f = await fixture();
  expect(() => createModelSearchStudyAdapter({ ...f, finalConfig: { ...f.finalConfig, cases: f.searchConfig.cases, retentionPolicy: { profileId: "critical-parser", version: 1, criticalCaseIds: ["search-held-out-0"] } }, parents: new Map([[f.baseline.id, f.baseline]]) })).toThrow(/overlaps/);
  expect(f.calls()).toBe(0);
});


it("does not relabel a token-rate estimate as an actual paid invoice", async () => {
  const f = await fixture();
  const adapter = createModelSearchStudyAdapter({ ...f, observeBilling: async () => ({ actualUsd: null, receiptDigest: null }), parents: new Map([[f.baseline.id, f.baseline]]) });
  const result = await adapter.propose({ seed: "invoice-control", arm: "current", ordinal: 0, ceilingUsd: .1,
    maxWorkerExecutions: 0, maxRetainedBytes: 262144, parentId: f.baseline.id, feedback: "development-only" });
  expect(result.status).toBe("inconclusive");
  expect(result.charges[0]!.actualUsd).toBeNull();
  expect(f.calls()).toBe(1);
});
