/** Explicit #122 ablation. No production optimizer imports or width defaults. */
import { evolutionDigest } from "./registry.js";
import { runPairedSearchStudy, validateSearchStudyPlan, type SearchStudyAdapter, type SearchStudyPlan } from "./paired-search-study.js";

/** Host-owned reconciliation/review of the #120 report. Keep the report intact;
 * booleans supplied by a candidate are never qualification evidence. */
export interface SequentialPilotEvidence {
  report: {
    mode: string;
    conclusion: "qualified-for-experiment" | "inconclusive" | "negative";
    protocolDigest: string;
    corpusDigest: string;
    pairedAnalysis: { independentFamilies: number; interval95: [number, number]; retentionRegressions: number; regressionDetected: boolean };
    cost: { billedUsd: number | null; localComputeUsd: number | null; unknownUsage: boolean };
    receipts: Array<{ identity: { provider: string; model: string; responseModel: string | null; modelVersionStatus: "pinned" | "floating" | "unavailable"; decoding: { temperature: number; seed: number } } }>;
  };
  reportDigest: string;
  reviewRef: string;
  /** Predeclared minimum from the pilot's independently reviewed protocol. */
  minimumIndependentFamilies: number;
}
export function admitSequentialPilotForDiversity(evidence: SequentialPilotEvidence): void {
  const { report } = evidence;
  if (!evidence.reviewRef.trim() || evidence.reviewRef.length > 1024 || evolutionDigest(report) !== evidence.reportDigest
    || !/^sha256:[a-f0-9]{64}$/.test(report.protocolDigest) || !/^sha256:[a-f0-9]{64}$/.test(report.corpusDigest)) {
    throw new Error("immutable pilot report and independent review are required");
  }
  if (report.mode !== "provider" || report.conclusion !== "qualified-for-experiment" || report.cost.unknownUsage !== false || report.cost.billedUsd === null || report.cost.localComputeUsd === null
    || !Number.isFinite(report.cost.billedUsd) || report.cost.billedUsd < 0 || !Number.isFinite(report.cost.localComputeUsd) || report.cost.localComputeUsd < 0) {
    throw new Error("pilot actual provider and compute costs must be fully reconciled before wider search");
  }
  if (!Number.isSafeInteger(evidence.minimumIndependentFamilies) || evidence.minimumIndependentFamilies < 2 || evidence.minimumIndependentFamilies > 1000
    || !Number.isSafeInteger(report.pairedAnalysis.independentFamilies) || report.pairedAnalysis.independentFamilies > 1000
    || report.pairedAnalysis.independentFamilies < evidence.minimumIndependentFamilies || report.pairedAnalysis.regressionDetected !== true
    || report.pairedAnalysis.retentionRegressions !== 0 || !Array.isArray(report.pairedAnalysis.interval95) || report.pairedAnalysis.interval95.length !== 2 || report.pairedAnalysis.interval95[0] <= 0
    || report.pairedAnalysis.interval95[0] > report.pairedAnalysis.interval95[1]
    || report.pairedAnalysis.interval95.some(bound => !Number.isFinite(bound) || bound < -1 || bound > 1)) {
    throw new Error("sequential pilot benefit, regression controls and retention are not qualified");
  }
  if (!report.receipts.length || report.receipts.length > 100_000) throw new Error("bounded pinned pilot execution evidence required");
  const identity = evolutionDigest(report.receipts[0]!.identity);
  for (const receipt of report.receipts) {
    const observed = receipt.identity;
    if (!observed?.provider || !observed.model || observed.modelVersionStatus !== "pinned" || observed.responseModel !== observed.model
      || !Number.isFinite(observed.decoding.temperature) || !Number.isSafeInteger(observed.decoding.seed)
      || evolutionDigest(observed) !== identity) throw new Error("pilot runtime/model/decoding identity is floating or incompatible");
  }
}

export function validateProposalDiversityPlan(plan: SearchStudyPlan, width: number): void {
  if (![2, 3].includes(width)) throw new Error("explicit proposal width must be two or three");
  validateSearchStudyPlan(plan, [{ id: "width-one", width: 1, parentId: () => "baseline", feedback: "" },
    { id: `width-${width}`, width, parentId: () => "baseline", feedback: "" }]);
  const cohortMaximumUsd = width * (plan.ceilings.proposal + plan.ceilings.build + plan.ceilings.development);
  if (plan.maxProposals < width || plan.armBudgetUsd - plan.finalReserveUsd < cohortMaximumUsd
    || plan.maxWorkerExecutions - plan.finalReserveExecutions < width * plan.developmentExecutions) {
    throw new Error("complete wider cohort and independent final capacity must fit the predeclared cap");
  }
}

/** Same parent, editable surface and feedback representation in both arms. The
 * shared native adapter owns editable/sandbox invariants; this wrapper changes
 * only cohort width, not parent selection or the final shortlist rule. */
export async function runProposalDiversityStudy(options: {
  plan: SearchStudyPlan;
  qualifiedPilot: SequentialPilotEvidence;
  approvedBudgetUsd: number;
  width: 2 | 3;
  parentId: string;
  feedback: string;
  adapter: SearchStudyAdapter;
  now?: () => number;
}) {
  admitSequentialPilotForDiversity(options.qualifiedPilot);
  validateProposalDiversityPlan(options.plan, options.width);
  const maximumTotalSpendUsd = options.plan.armBudgetUsd * options.plan.seeds.length * 2;
  if (!Number.isFinite(options.approvedBudgetUsd) || options.approvedBudgetUsd <= 0 || options.approvedBudgetUsd > 1000
    || maximumTotalSpendUsd > options.approvedBudgetUsd) throw new Error("explicit spending cap cannot cover both paired arms and their reserved final validation");
  const report = await runPairedSearchStudy({ plan: options.plan, adapter: options.adapter, now: options.now,
    arms: [{ id: "width-one", parentId: () => options.parentId, width: 1, feedback: options.feedback },
      { id: `width-${options.width}`, parentId: () => options.parentId, width: options.width, feedback: options.feedback }],
  });
  return { qualification: { pilotReportDigest: options.qualifiedPilot.reportDigest, reviewRef: options.qualifiedPilot.reviewRef },
    experimentalVariable: "same-parent proposal cohort width" as const, concurrency: 1 as const,
    maximumTotalSpendUsd, combinedPatches: false as const, report };
}
