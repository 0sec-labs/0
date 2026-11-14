/** Reproducible controller controls, not evidence of model/search efficacy. */
import { evolutionDigest } from "./registry.js";
import { runArchiveSearchStudy } from "./archive-study-runner.js";
import type { SearchStudyAdapter, SearchStudyDispatch, SearchStudyPlan } from "./paired-search-study.js";
import type { PilotIdentity } from "../bench/security-evolution-pilot.js";

export const CONTROL_SEARCH_PLAN: SearchStudyPlan = {
  schemaVersion: 1, protocolRef: "deterministic-controller-control-v1", seeds: ["control-1", "control-2", "control-3", "control-4"],
  armBudgetUsd: 1, maxWorkerExecutions: 30, maxProposals: 4, maxRetainedBytes: 1024 * 1024,
  finalReserveUsd: 0.4, finalReserveExecutions: 12, ceilings: { proposal: 0.05, build: 0.01, development: 0.05, final: 0.4 },
  developmentExecutions: 2, finalExecutions: 12,
};
export const CONTROL_IDENTITY: PilotIdentity = { provider: "deterministic-control", resolvedModel: "none-controller-fixture-v1", modelVersionStatus: "pinned",
  sourceDigest: evolutionDigest("control-source"), imageDigest: evolutionDigest("control-image"), evaluatorDigest: evolutionDigest("control-oracle"), decodingDigest: evolutionDigest("no-decoding"), harnessDigest: evolutionDigest("control-baseline") };

export function createDeterministicSearchStudyAdapter(mode: "aa" | "regression" = "aa"): SearchStudyAdapter {
  const candidates = new Map<string, { parent: string; index: number }>();
  const counts = new Map<string, number>();
  const charge = (r: SearchStudyDispatch, phase: string, actualUsd: number, category: "proposal" | "compute" | "build") => [{ id: `${r.seed}:${r.arm}:${r.ordinal}:${phase}`, category, actualUsd }];
  return {
    async propose(r) {
      const key = `${r.seed}:${r.arm}`;
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      // The second proposal is an equivalent edit. Its proposal cost is real
      // even though deterministic duplicate screening skips another worker run.
      const artifactIndex = index === 1 ? 0 : index;
      const id = `${r.seed}:${r.arm}:candidate-${artifactIndex}`;
      candidates.set(id, { parent: r.parentId, index: artifactIndex });
      return { value: { id, digest: evolutionDigest([mode, r.parentId, artifactIndex]), hypothesis: "Control proposal", observedFailure: "Synthetic parser outcome", changedSurface: "fixture/parser.cjs", risk: "Controller fixture only" }, charges: charge(r, "proposal", 0.01, "proposal"), workerExecutions: 0, retainedBytes: 128, status: "ok" };
    },
    async build(r) {
      const rejected = candidates.get(r.candidate.id)!.index === 2;
      return { value: rejected ? null : true, charges: charge(r, "build", 0.002, "build"), workerExecutions: 0, retainedBytes: 0, status: rejected ? "rejected" : "ok", reason: rejected ? "deliberately rejected build control" : undefined };
    },
    async development(r) {
      const data = candidates.get(r.candidate.id)!;
      const score = data.index === 3 ? 1 : 0.5;
      return { value: { score, feedback: JSON.stringify({ developmentScore: score }) }, charges: charge(r, "development", 0.02, "compute"), workerExecutions: r.maxWorkerExecutions, retainedBytes: 0, status: "ok" };
    },
    async final(r) {
      const regression = mode === "regression" && candidates.get(r.candidate.id)!.parent === "older-diverse";
      return { value: { verifiedQuality: regression ? 1 : 0.75, falsePositives: regression ? 1 : 0, retentionPassed: !regression, evidenceValid: true,
        identity: { ...CONTROL_IDENTITY, harnessDigest: r.candidate.digest } }, charges: charge(r, "final", 0.08, "compute"), workerExecutions: r.maxWorkerExecutions, retainedBytes: 0, status: "ok" };
    },
  };
}
export async function runArchiveStudyControls(mode: "aa" | "regression" = "aa") {
  const observations = [{ id: "current", solved: [0, 1] }, { id: "older-diverse", solved: [2] }, { id: "redundant", solved: [0] }].map(parent => ({
    id: parent.id, attempts: [0, 1, 2].flatMap(index => [0, 1].map(repeat => ({ caseId: `development-${index}`, lane: "development" as const, repeat, matched: parent.solved.includes(index), inconclusive: false }))),
  }));
  let clock = 0;
  const report = await runArchiveSearchStudy({ plan: CONTROL_SEARCH_PLAN, currentId: "current", observations, repeats: 2, feedback: "Identical development-only feedback", adapter: createDeterministicSearchStudyAdapter(mode), now: () => clock += 5 });
  return { evidenceKind: "deterministic-controller-control" as const, mode, productionDefaultsChanged: false as const, report };
}
