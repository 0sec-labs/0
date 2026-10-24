/** Conditional #122 ablation: development screening only, never activation. */
import { createHash } from "node:crypto";
import type { EvolutionEdit } from "./types.js";

export interface DiversityStudyPolicy {
  qualifiedPilotRef: string;
  proposalWidth: number;
  maxConcurrency: number;
  maxRetainedBytes: number;
  parentDigest: string;
  editablePaths: string[];
  feedbackDigest: string;
  totalBudgetUsd: number;
  finalValidationBudgetUsd: number;
  maxWorkerExecutions: number;
  finalValidationExecutions: number;
}
export interface DiversityStudyProposal {
  id: string;
  parentDigest: string;
  feedbackDigest: string;
  hypothesis: string;
  targetedFailureRef: string;
  risk: string;
  edits: EvolutionEdit[];
  /** Trusted development-only screen. Private lane scores are forbidden. */
  screen: { lane: "development"; score: number };
  actualSearchUsd: number | null;
  workerExecutions: number;
}
function integer(n: number, min: number): boolean { return Number.isSafeInteger(n) && n >= min; }
function safePath(p: string): boolean { return !!p && !p.startsWith("/") && !p.includes("\\") && p.split("/").every(s => !!s && s !== "." && s !== ".."); }
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

/** Same fixed parent + feedback + editable surface in both study arms. */
export function shortlistDiversityStudy(policy: DiversityStudyPolicy, proposals: DiversityStudyProposal[]): {
  selectedId: string | null;
  rejected: Array<{ id: string; reason: string }>;
  actualSearchUsd: number;
  workerExecutions: number;
  requiresIndependentValidation: true;
} {
  if (!policy.qualifiedPilotRef.trim()) throw new Error("sequential pilot must be qualified before diversity execution");
  if (!integer(policy.proposalWidth, 1) || policy.proposalWidth > 8 || !integer(policy.maxConcurrency, 1) || policy.maxConcurrency > policy.proposalWidth || !integer(policy.maxRetainedBytes, 1) || policy.maxRetainedBytes > 16 * 1024 * 1024 || proposals.length > policy.proposalWidth) throw new Error("invalid bounded proposal policy");
  if (![policy.totalBudgetUsd, policy.finalValidationBudgetUsd].every(n => Number.isFinite(n) && n > 0) || policy.finalValidationBudgetUsd > policy.totalBudgetUsd || !integer(policy.maxWorkerExecutions, 1) || !integer(policy.finalValidationExecutions, 1) || policy.finalValidationExecutions > policy.maxWorkerExecutions) throw new Error("complete independent validation capacity is required");
  if (!/^sha256:[a-f0-9]{64}$/.test(policy.parentDigest) || !/^sha256:[a-f0-9]{64}$/.test(policy.feedbackDigest) || !policy.editablePaths.length || policy.editablePaths.some(p => !safePath(p))) throw new Error("fixed parent, feedback and editable surface are required");
  const rejected: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  const eligible: DiversityStudyProposal[] = [];
  let actualSearchUsd = 0;
  let workerExecutions = 0;
  let bytes = 0;
  for (const p of proposals) {
    if (!p.id || p.id.length > 128 || ids.has(p.id)) throw new Error("duplicate/invalid proposal id");
    ids.add(p.id);
    // Rejected and equivalent proposals still consume the full reported cost.
    if (p.actualSearchUsd === null || !Number.isFinite(p.actualSearchUsd) || p.actualSearchUsd < 0 || !integer(p.workerExecutions, 0)) throw new Error("unknown proposal/search usage cannot be treated as free");
    actualSearchUsd += p.actualSearchUsd;
    workerExecutions += p.workerExecutions;
    if (actualSearchUsd + policy.finalValidationBudgetUsd > policy.totalBudgetUsd || workerExecutions + policy.finalValidationExecutions > policy.maxWorkerExecutions) throw new Error("search exhausted reserved final validation capacity");
    let reason: string | null = null;
    if (p.parentDigest !== policy.parentDigest || p.feedbackDigest !== policy.feedbackDigest) reason = "parent or feedback changed; comparison is confounded";
    if ([p.hypothesis, p.targetedFailureRef, p.risk].some(s => typeof s !== "string" || Buffer.byteLength(s) > 2048)) throw new Error("oversized hypothesis/failure/risk");
    if (![p.hypothesis, p.targetedFailureRef, p.risk].every(s => !!s.trim())) reason = "missing hypothesis/failure/risk";
    if (p.screen.lane !== "development" || !Number.isFinite(p.screen.score) || p.screen.score < 0 || p.screen.score > 1) reason = "invalid development-only screen";
    if (!p.edits.length || p.edits.length > policy.editablePaths.length || new Set(p.edits.map(e => e.path)).size !== p.edits.length || p.edits.some(e => !policy.editablePaths.includes(e.path) || (e.content !== null && typeof e.content !== "string"))) reason = "edit outside fixed allowed surface";
    // Check individual fields before serializing, avoiding a second huge copy
    // when a malformed proposal supplies unbounded edit content.
    for (const e of p.edits) {
      if (typeof e.path !== "string" || e.path.length > 1024 || (e.beforeDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(e.beforeDigest)) || (typeof e.content === "string" && Buffer.byteLength(e.content) > policy.maxRetainedBytes)) throw new Error("proposal retention bound or edit identity invalid");
    }
    bytes += Buffer.byteLength(JSON.stringify(p));
    if (bytes > policy.maxRetainedBytes) throw new Error("proposal retention bound exhausted");
    if (!reason) {
      const editsDigest = sha(JSON.stringify([...p.edits].sort((a, b) => a.path.localeCompare(b.path)).map(e => [e.path, e.beforeDigest, e.content])));
      if (seen.has(editsDigest)) reason = "equivalent edit";
      else seen.add(editsDigest);
    }
    if (reason) rejected.push({ id: p.id, reason });
    else eligible.push(p);
  }
  // Predeclared single-candidate selection, deterministic id tie-break. No patch
  // combination, private score ranking, registry insertion or deployment.
  eligible.sort((a, b) => b.screen.score - a.screen.score || a.id.localeCompare(b.id));
  return { selectedId: eligible[0]?.id ?? null, rejected, actualSearchUsd, workerExecutions, requiresIndependentValidation: true };
}
