/** Deterministic controls bypass no paid qualification: they call only the
 * controller fixture adapter and never instantiate a provider runtime. */
import { runPairedSearchStudy } from "./paired-search-study.js";
import { CONTROL_SEARCH_PLAN, createDeterministicSearchStudyAdapter } from "./search-study-controls.js";
export async function runProposalDiversityControls(mode: "null" | "inconclusive" = "null") {
  const plan = { ...CONTROL_SEARCH_PLAN, protocolRef: "proposal-diversity-controller-control-v1", armBudgetUsd: .2,
    maxProposals: 20, finalReserveUsd: .08, ceilings: { proposal: .03, build: .01, development: .03, final: .08 } };
  const adapter = createDeterministicSearchStudyAdapter();
  if (mode === "inconclusive") adapter.propose = async request => ({ value: null,
    charges: [{ id: `${request.seed}:${request.arm}:${request.ordinal}:unknown`, category: "proposal", actualUsd: null }],
    workerExecutions: 0, retainedBytes: 0, status: "inconclusive", reason: "injected unknown provider charge" });
  let clock = 0;
  const report = await runPairedSearchStudy({ plan, adapter, now: () => clock += 5,
    arms: [{ id: "width-one", parentId: () => "same-frozen-parent", width: 1, feedback: "Same development-only feedback format" },
      { id: "width-three", parentId: () => "same-frozen-parent", width: 3, feedback: "Same development-only feedback format" }],
  });
  return { evidenceKind: "deterministic-controller-control" as const, mode, productionDefaultsChanged: false as const,
    concurrency: 1 as const, combinedPatches: false as const, maximumTotalSpendUsd: plan.armBudgetUsd * plan.seeds.length * 2, report };
}
