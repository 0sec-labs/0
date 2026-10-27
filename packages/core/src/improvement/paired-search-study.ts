/** Explicit offline experiment orchestration. Never imported by ordinary scans.
 * Charge records are the #120 report contract, not a second durable ledger.
 * Real dispatch adapters must reserve/settle through the campaign ledger. */
import { evolutionDigest } from "./registry.js";
import type { PilotCharge, PilotIdentity } from "../bench/security-evolution-pilot.js";

export interface SearchStudyCandidate {
  id: string;
  digest: string;
  hypothesis: string;
  observedFailure: string;
  changedSurface: string;
  risk: string;
}
export interface SearchStudyOperation<T> {
  value: T | null;
  charges: PilotCharge[];
  workerExecutions: number;
  retainedBytes: number;
  status: "ok" | "rejected" | "inconclusive";
  reason?: string;
}
export interface SearchStudyDispatch {
  seed: string;
  arm: string;
  ordinal: number;
  ceilingUsd: number;
  maxWorkerExecutions: number;
  maxRetainedBytes: number;
}
export interface SearchStudyFinal {
  verifiedQuality: number;
  falsePositives: number;
  retentionPassed: boolean;
  evidenceValid: boolean;
  identity: PilotIdentity;
}
export interface SearchStudyAdapter {
  /** No sealed scores/results may enter these three search callbacks. */
  propose(request: SearchStudyDispatch & { parentId: string; feedback: string }): Promise<SearchStudyOperation<SearchStudyCandidate>>;
  build(request: SearchStudyDispatch & { candidate: SearchStudyCandidate }): Promise<SearchStudyOperation<true>>;
  development(request: SearchStudyDispatch & { candidate: SearchStudyCandidate }): Promise<SearchStudyOperation<{ score: number; feedback: string }>>;
  /** Controller-only independent evaluation after the fixed development shortlist. */
  final(request: SearchStudyDispatch & { candidate: SearchStudyCandidate }): Promise<SearchStudyOperation<SearchStudyFinal>>;
}
export interface SearchStudyPlan {
  schemaVersion: 1;
  protocolRef: string;
  seeds: string[];
  armBudgetUsd: number;
  maxWorkerExecutions: number;
  maxProposals: number;
  maxRetainedBytes: number;
  finalReserveUsd: number;
  finalReserveExecutions: number;
  ceilings: { proposal: number; build: number; development: number; final: number };
  developmentExecutions: number;
  finalExecutions: number;
}
export interface SearchStudyArm {
  id: string;
  parentId: (seed: string) => string;
  width: number;
  /** Format and initial feedback held constant across the paired study. */
  feedback: string;
}
export interface SearchStudyTrial {
  seed: string;
  arm: string;
  parentId: string;
  width: number;
  status: "completed" | "inconclusive";
  reason: string | null;
  proposals: number;
  rejected: number;
  duplicates: number;
  workerExecutions: number;
  retainedBytes: number;
  charges: PilotCharge[];
  knownSpendUsd: number;
  unknownCharges: number;
  elapsedMs: number;
  selectedDigest: string | null;
  final: SearchStudyFinal | null;
}
export interface SearchStudyReport {
  schemaVersion: 1;
  planDigest: string;
  trials: SearchStudyTrial[];
  comparison: Array<{ arm: string; pairs: number; medianQuality: number | null; bestQuality: number | null; pairedMeanQualityDelta: number | null; pairedMeanDelta95: [number, number] | null; falsePositives: number; retentionFailures: number; inconclusives: number; knownSpendUsd: number; unknownCharges: number; elapsedMs: number }>;
  decision: "retain-default";
  automaticPromotion: false;
}
const digestPattern = /^sha256:[a-f0-9]{64}$/;
function positive(n: number, name: string, max: number, integer = false): void {
  if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`invalid ${name}`);
}
export function validateSearchStudyPlan(plan: SearchStudyPlan, arms: SearchStudyArm[]): void {
  if (plan.schemaVersion !== 1 || !plan.protocolRef.trim() || plan.protocolRef.length > 1024) throw new Error("bounded preregistered protocol required");
  if (plan.seeds.length < 2 || plan.seeds.length > 30 || new Set(plan.seeds).size !== plan.seeds.length || plan.seeds.some(seed => !seed || seed.length > 128)) throw new Error("two to thirty independent paired seeds required");
  positive(plan.armBudgetUsd, "arm budget", 1000);
  positive(plan.maxWorkerExecutions, "worker executions", 100_000, true);
  positive(plan.maxProposals, "proposal count", 100, true);
  positive(plan.maxRetainedBytes, "retained bytes", 64 * 1024 * 1024, true);
  positive(plan.finalReserveUsd, "final reserve", plan.armBudgetUsd);
  positive(plan.finalReserveExecutions, "final executions reserve", plan.maxWorkerExecutions, true);
  positive(plan.developmentExecutions, "development executions", plan.maxWorkerExecutions, true);
  positive(plan.finalExecutions, "final executions", plan.maxWorkerExecutions, true);
  for (const [key, value] of Object.entries(plan.ceilings)) positive(value, `${key} ceiling`, plan.armBudgetUsd);
  if (plan.finalReserveUsd < plan.ceilings.final || plan.finalReserveExecutions < plan.finalExecutions
    || plan.armBudgetUsd - plan.finalReserveUsd < plan.ceilings.proposal + plan.ceilings.build + plan.ceilings.development
    || plan.maxWorkerExecutions - plan.finalReserveExecutions < plan.developmentExecutions) throw new Error("budget cannot reserve complete search and independent final validation");
  if (arms.length < 2 || arms.length > 4 || new Set(arms.map(arm => arm.id)).size !== arms.length) throw new Error("two to four distinct study arms required");
  for (const arm of arms) {
    if (!/^[a-z0-9-]{1,64}$/.test(arm.id) || arm.feedback.length > 8192) throw new Error("invalid bounded arm");
    positive(arm.width, "proposal width", 3, true);
  }
}
function candidateValid(candidate: SearchStudyCandidate): boolean {
  return !!candidate.id && candidate.id.length <= 128 && digestPattern.test(candidate.digest)
    && [candidate.hypothesis, candidate.observedFailure, candidate.changedSurface, candidate.risk].every(value => typeof value === "string" && !!value && value.length <= 2048);
}
function identityValid(identity: PilotIdentity): boolean {
  return identity.modelVersionStatus === "pinned" && !!identity.provider && !!identity.resolvedModel
    && [identity.sourceDigest, identity.imageDigest, identity.evaluatorDigest, identity.decodingDigest, identity.harnessDigest].every(value => digestPattern.test(value));
}

/** Equal total spend/execution ceilings per arm and seed, not equal generations.
 * Sequential dispatch keeps concurrency at one; width changes only a fixed-parent
 * cohort before feedback advances. No automatic patch combination or activation. */
export async function runPairedSearchStudy(options: {
  plan: SearchStudyPlan;
  arms: SearchStudyArm[];
  adapter: SearchStudyAdapter;
  now?: () => number;
}): Promise<SearchStudyReport> {
  const { plan, arms, adapter } = options;
  validateSearchStudyPlan(plan, arms);
  const now = options.now ?? Date.now;
  const trials: SearchStudyTrial[] = [];
  let comparisonIdentity: string | null = null;
  let studyStopReason: string | null = null;
  for (let seedIndex = 0; seedIndex < plan.seeds.length; seedIndex++) {
    const seed = plan.seeds[seedIndex]!;
    // Rotate complete campaigns to avoid a permanently first/warm arm.
    const ordered = [...arms.slice(seedIndex % arms.length), ...arms.slice(0, seedIndex % arms.length)];
    for (const arm of ordered) {
      const started = now();
      const parentId = arm.parentId(seed);
      if (!parentId || parentId.length > 128) throw new Error("invalid parent identity");
      const trial: SearchStudyTrial = { seed, arm: arm.id, parentId, width: arm.width, status: "inconclusive", reason: null, proposals: 0, rejected: 0, duplicates: 0, workerExecutions: 0, retainedBytes: 0, charges: [], knownSpendUsd: 0, unknownCharges: 0, elapsedMs: 0, selectedDigest: null, final: null };
      if (studyStopReason) {
        trial.reason = studyStopReason;
        trials.push(trial);
        continue;
      }
      const chargeIds = new Set<string>();
      const seen = new Set<string>();
      let best: { candidate: SearchStudyCandidate; score: number; feedback: string } | null = null;
      let feedback = arm.feedback;
      let ordinal = 0;
      const dispatch = (ceilingUsd: number, maxWorkerExecutions: number): SearchStudyDispatch => ({ seed, arm: arm.id, ordinal: ordinal++, ceilingUsd, maxWorkerExecutions, maxRetainedBytes: plan.maxRetainedBytes - trial.retainedBytes });
      const settle = <T>(result: SearchStudyOperation<T>, request: SearchStudyDispatch): boolean => {
        let cost = 0;
        if (!result || !Array.isArray(result.charges) || !result.charges.length || result.charges.length > 1024) { trial.reason = "missing actual cost receipt"; trial.unknownCharges++; return false; }
        for (const charge of result.charges) {
          if (!charge.id || charge.id.length > 256 || chargeIds.has(charge.id) || !["proposal", "worker-model", "compute", "build", "summary"].includes(charge.category)) { trial.reason = "invalid or duplicate cost receipt"; return false; }
          chargeIds.add(charge.id);
          trial.charges.push(charge);
          if (charge.actualUsd === null || !Number.isFinite(charge.actualUsd) || charge.actualUsd < 0) trial.unknownCharges++;
          else { cost += charge.actualUsd; trial.knownSpendUsd += charge.actualUsd; }
        }
        if (trial.unknownCharges) { trial.reason = "unknown charge; reconcile before further dispatch"; return false; }
        const validExecutions = Number.isSafeInteger(result.workerExecutions) && result.workerExecutions >= 0;
        const validBytes = Number.isSafeInteger(result.retainedBytes) && result.retainedBytes >= 0;
        const receiptBytes = Buffer.byteLength(JSON.stringify(result.charges));
        if (validExecutions) trial.workerExecutions += result.workerExecutions;
        if (validBytes) trial.retainedBytes += result.retainedBytes + receiptBytes;
        if (!validExecutions || result.workerExecutions > request.maxWorkerExecutions
          || !validBytes || result.retainedBytes + receiptBytes > request.maxRetainedBytes
          || cost > request.ceilingUsd) { trial.reason = "adapter exceeded dispatch resource ceiling"; return false; }
        if (result.status === "inconclusive") { trial.reason = result.reason?.slice(0, 1024) ?? "inconclusive operation"; return false; }
        if (!["ok", "rejected"].includes(result.status)) { trial.reason = "invalid operation status"; return false; }
        return true;
      };
      try {
        search: while (trial.proposals < plan.maxProposals) {
          // All candidates in a cohort see the same parent and development feedback.
          const cohortFeedback = feedback;
          for (let member = 0; member < arm.width && trial.proposals < plan.maxProposals; member++) {
            const remaining = plan.armBudgetUsd - plan.finalReserveUsd - trial.knownSpendUsd;
            if (remaining < plan.ceilings.proposal + plan.ceilings.build + plan.ceilings.development
              || plan.maxWorkerExecutions - plan.finalReserveExecutions - trial.workerExecutions < plan.developmentExecutions) break search;
            const proposalRequest = dispatch(plan.ceilings.proposal, 0);
            trial.proposals++;
            const proposal = await adapter.propose({ ...proposalRequest, parentId, feedback: cohortFeedback });
            if (!settle(proposal, proposalRequest)) break search;
            if (proposal.status === "rejected" || !proposal.value) { trial.rejected++; continue; }
            const candidate = proposal.value;
            if (!candidateValid(candidate)) { trial.reason = "malformed proposal metadata"; break search; }
            if (seen.has(candidate.digest)) { trial.duplicates++; continue; }
            seen.add(candidate.digest);
            const buildRequest = dispatch(plan.ceilings.build, 0);
            const built = await adapter.build({ ...buildRequest, candidate });
            if (!settle(built, buildRequest)) break search;
            if (built.status === "rejected" || !built.value) { trial.rejected++; continue; }
            const developmentRequest = dispatch(plan.ceilings.development, plan.developmentExecutions);
            const development = await adapter.development({ ...developmentRequest, candidate });
            if (!settle(development, developmentRequest)) break search;
            if (development.status === "rejected" || !development.value) { trial.rejected++; continue; }
            if (development.workerExecutions !== plan.developmentExecutions || !Number.isFinite(development.value.score)
              || development.value.score < 0 || development.value.score > 1 || development.value.feedback.length > 8192) { trial.reason = "incomplete development evidence"; break search; }
            if (!best || development.value.score > best.score) best = { candidate, ...development.value };
          }
          if (best) feedback = best.feedback;
        }
        if (!trial.reason && best) {
          trial.selectedDigest = best.candidate.digest;
          const finalRequest = dispatch(plan.ceilings.final, plan.finalExecutions);
          const final = await adapter.final({ ...finalRequest, candidate: best.candidate });
          if (settle(final, finalRequest) && final.status === "ok" && final.value
            && final.workerExecutions === plan.finalExecutions && identityValid(final.value.identity)
            && Number.isFinite(final.value.verifiedQuality) && final.value.verifiedQuality >= 0 && final.value.verifiedQuality <= 1
            && Number.isSafeInteger(final.value.falsePositives) && final.value.falsePositives >= 0
            && typeof final.value.retentionPassed === "boolean" && final.value.evidenceValid === true) {
            const { harnessDigest: _candidateArtifact, ...identity } = final.value.identity;
            const key = evolutionDigest(identity);
            if (comparisonIdentity !== null && comparisonIdentity !== key) trial.reason = "incompatible final provider/source/evaluator contract";
            else { comparisonIdentity = key; trial.final = final.value; trial.status = "completed"; }
          } else trial.reason ??= "incomplete independent final evidence";
        } else trial.reason ??= "no independently evaluable shortlist";
      } catch (error) {
        trial.reason = `adapter exception; charge reconciliation required: ${error instanceof Error ? error.message.slice(0, 512) : "unknown"}`;
        trial.unknownCharges++;
      }
      trial.elapsedMs = Math.max(0, now() - started);
      if (trial.unknownCharges || (trial.reason !== null && trial.reason !== "no independently evaluable shortlist")) {
        studyStopReason = "study stopped pending charge/resource/provenance reconciliation";
      }
      trials.push(trial);
    }
  }
  return summarizePairedSearchStudy(plan, arms, trials);
}

export function summarizePairedSearchStudy(plan: SearchStudyPlan, arms: SearchStudyArm[], trials: SearchStudyTrial[]): SearchStudyReport {
  const baseline = arms[0]!.id;
  const comparison = arms.map(arm => {
    const rows = trials.filter(trial => trial.arm === arm.id);
    const complete = rows.filter(trial => trial.status === "completed" && trial.final);
    const qualities = complete.map(trial => trial.final!.verifiedQuality).sort((a, b) => a - b);
    const deltas: number[] = [];
    for (const row of complete) {
      const control = trials.find(trial => trial.seed === row.seed && trial.arm === baseline && trial.status === "completed" && trial.final);
      if (control) deltas.push(row.final!.verifiedQuality - control.final!.verifiedQuality);
    }
    const mean = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null;
    // Bounded Hoeffding interval over independent paired-seed differences in
    // [-1,1]. Deliberately conservative; no normality or tiny-n t approximation.
    const radius = deltas.length ? Math.sqrt(2 * Math.log(40) / deltas.length) : 1;
    return { arm: arm.id, pairs: deltas.length, medianQuality: qualities.length ? (qualities[Math.floor((qualities.length - 1) / 2)]! + qualities[Math.floor(qualities.length / 2)]!) / 2 : null, bestQuality: qualities.length ? qualities[qualities.length - 1]! : null, pairedMeanQualityDelta: mean, pairedMeanDelta95: mean === null ? null : [Math.max(-1, mean - radius), Math.min(1, mean + radius)] as [number, number], falsePositives: complete.reduce((sum, trial) => sum + trial.final!.falsePositives, 0), retentionFailures: complete.filter(trial => !trial.final!.retentionPassed).length, inconclusives: rows.length - complete.length, knownSpendUsd: rows.reduce((sum, trial) => sum + trial.knownSpendUsd, 0), unknownCharges: rows.reduce((sum, trial) => sum + trial.unknownCharges, 0), elapsedMs: rows.reduce((sum, trial) => sum + trial.elapsedMs, 0) };
  });
  return { schemaVersion: 1, planDigest: evolutionDigest(plan), trials, comparison, decision: "retain-default", automaticPromotion: false };
}
