/** Explicit offline qualification only. Never imported by scan or promotion paths. */
import { createHash } from "node:crypto";
import type { BenchManifest } from "./manifest.js";
import type { BenchScanInput, BenchAttemptResult, TargetProvisioner } from "./runner.js";
import { runBenchCase } from "./runner.js";
import type { BenchScanResult, BenchOracle } from "./oracle.js";

export type PilotArm = "frozen-baseline" | "sequential" | "baseline-extra-attempts" | "summary" | "diversity" | "aa" | "regression";
export interface PilotPlan {
  schemaVersion: 1;
  objective: "quality" | "efficiency";
  arms: PilotArm[];
  repeats: number;
  maxWorkerExecutions: number;
  totalBudgetUsd: number;
  perExecutionCeilingUsd: number;
  finalValidationExecutions: number;
  finalValidationBudgetUsd: number;
  maxTurns: number;
  /** Curator-reviewed sampling, paired analysis, practical margins and adjudication. */
  protocolRef: string;
  /** Required before the summary/diversity ablations can dispatch. */
  qualifiedSequentialPilotRef?: string;
}
export interface PilotIdentity {
  provider: string;
  resolvedModel: string;
  modelVersionStatus: "pinned" | "floating" | "unavailable";
  sourceDigest: string;
  imageDigest: string;
  evaluatorDigest: string;
  decodingDigest: string;
  harnessDigest: string;
}
export interface PilotCharge {
  id: string;
  category: "proposal" | "worker-model" | "compute" | "build" | "summary";
  /** Actual charge; null means unknown, never free. */
  actualUsd: number | null;
}
export interface PilotMeasurement {
  report: BenchScanResult;
  identity: PilotIdentity;
  modelUsd: number | null;
  computeUsd: number | null;
  /** Trusted controller gates, not model claims. Missing evidence is not a pass. */
  invariants: { authorityPreserved: boolean; evidenceValid: boolean };
}
export type PilotScan = (input: BenchScanInput & { arm: PilotArm; ceilingUsd: number }) => Promise<PilotMeasurement>;
export interface PilotReceipt {
  arm: PilotArm;
  caseId: string;
  family: string;
  control: "vulnerable" | "fixed" | "clean";
  repeat: number;
  result: BenchAttemptResult;
  identity: PilotIdentity | null;
  invariants: PilotMeasurement["invariants"] | null;
  modelUsd: number | null;
  computeUsd: number | null;
  elapsedMs: number;
}
export interface PilotReport {
  schemaVersion: 1;
  planDigest: string;
  status: "completed-for-review" | "inconclusive";
  stopReason: string | null;
  receipts: PilotReceipt[];
  charges: PilotCharge[];
  knownSpendUsd: number;
  unknownCharges: number;
  elapsedMs: number;
  byArm: Partial<Record<PilotArm, { verifiedPositives: number; positiveAttempts: number; falseAlarms: number; negativeAttempts: number; inconclusives: number; p50Ms: number | null; p95Ms: number | null }>>;
  /** Tool completion never grants promotion or default enablement. */
  automaticPromotion: false;
}
const hash = (v: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`;
function positive(n: number, label: string, integer = false): void {
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) throw new Error(`invalid ${label}`);
}
export function preflightSecurityPilot(plan: PilotPlan, cases: number): { plannedExecutions: number; maximumEvaluationUsd: number; perArmSearchBudgetUsd: number } {
  positive(cases, "case count", true);
  for (const key of ["repeats", "maxWorkerExecutions", "finalValidationExecutions", "maxTurns"] as const) positive(plan[key], key, true);
  for (const key of ["totalBudgetUsd", "perExecutionCeilingUsd", "finalValidationBudgetUsd"] as const) positive(plan[key], key);
  if (plan.schemaVersion !== 1 || !["quality", "efficiency"].includes(plan.objective) || !plan.protocolRef.trim()) throw new Error("a preregistered protocol is required");
  const allowed: PilotArm[] = ["frozen-baseline", "sequential", "baseline-extra-attempts", "summary", "diversity", "aa", "regression"];
  if (new Set(plan.arms).size !== plan.arms.length || plan.arms.some(a => !allowed.includes(a)) || !["frozen-baseline", "sequential", "aa", "regression"].every(a => plan.arms.includes(a as PilotArm))) throw new Error("baseline, sequential, A/A and regression arms are required exactly once");
  if (plan.arms.includes("summary") && plan.arms.includes("diversity")) throw new Error("summary and diversity must first be tested separately");
  if (plan.arms.some(a => a === "summary" || a === "diversity") && !plan.qualifiedSequentialPilotRef?.trim()) throw new Error("ablations require a qualified sequential pilot");
  const plannedExecutions = plan.arms.length * cases * plan.repeats;
  const maximumEvaluationUsd = plannedExecutions * plan.perExecutionCeilingUsd;
  if (!Number.isSafeInteger(plannedExecutions) || plannedExecutions + plan.finalValidationExecutions > plan.maxWorkerExecutions || maximumEvaluationUsd + plan.finalValidationBudgetUsd > plan.totalBudgetUsd) throw new Error("budget cannot cover complete evaluation and reserved final validation");
  return { plannedExecutions, maximumEvaluationUsd, perArmSearchBudgetUsd: (plan.totalBudgetUsd - plan.finalValidationBudgetUsd - maximumEvaluationUsd) / plan.arms.length };
}
/** Existing default full baseline/candidate + canary execution load. Not a dollar estimate. */
export function estimateEvolutionExecutions(casesPerLane = 10, lanes = 3, repeats = 3, canaries = 2, candidates = 1): number {
  for (const n of [casesPerLane, lanes, repeats, candidates]) positive(n, "execution estimate", true);
  if (!Number.isSafeInteger(canaries) || canaries < 0) throw new Error("invalid canaries");
  const count = 2 * casesPerLane * lanes * repeats * (1 + canaries) * candidates;
  if (!Number.isSafeInteger(count)) throw new Error("execution estimate overflow");
  return count;
}
function validIdentity(i: PilotIdentity): boolean {
  return i.modelVersionStatus === "pinned" && [i.provider, i.resolvedModel].every(v => typeof v === "string" && !!v.trim()) && [i.sourceDigest, i.imageDigest, i.evaluatorDigest, i.decodingDigest, i.harnessDigest].every(v => /^sha256:[a-f0-9]{64}$/.test(v));
}
function knownCharge(n: number | null): n is number { return n !== null && Number.isFinite(n) && n >= 0; }

/**
 * Trusted benchmark/provider adapter, not a candidate-code execution interface.
 * The injected scan must enforce ceilingUsd at provider dispatch and return actual
 * billing even on failure. Missing billing terminates the supervised study.
 * Final validation is reserved, untouched and deliberately not exposed here.
 */
export async function runSecurityEvolutionPilot(options: {
  plan: PilotPlan;
  manifest: BenchManifest;
  labels: Record<string, { family: string; control: PilotReceipt["control"] }>;
  scan: PilotScan;
  oracle?: BenchOracle;
  provisioner?: TargetProvisioner;
  /** All search charges, including rejected proposals and failed builds. */
  searchCharges: Partial<Record<PilotArm, PilotCharge[]>>;
  now?: () => number;
}): Promise<PilotReport> {
  const { plan, manifest } = options;
  const preflight = preflightSecurityPilot(plan, manifest.cases.length);
  const ids = new Set<string>();
  for (const c of manifest.cases) {
    const label = options.labels[c.id];
    if (ids.has(c.id) || !label?.family?.trim() || !["vulnerable", "fixed", "clean"].includes(label.control) || c.knownNegative !== (label.control !== "vulnerable")) throw new Error("each unique case needs consistent independent family/control labels");
    ids.add(c.id);
  }
  if (new Set(manifest.cases.map(c => `${c.target.kind}:${c.objective.type}`)).size !== 1) throw new Error("pilot must isolate one security workflow");
  if (!["vulnerable", "fixed", "clean"].every(control => manifest.cases.some(c => options.labels[c.id].control === control))) throw new Error("vulnerable, fixed and clean controls are required");
  const charges: PilotCharge[] = [];
  const chargeIds = new Set<string>();
  for (const arm of plan.arms) {
    const armCharges = options.searchCharges[arm];
    if (!armCharges) throw new Error(`search accounting missing for ${arm}; supply [] for no search`);
    let total = 0;
    for (const c of armCharges) {
      if (!c.id || chargeIds.has(c.id) || !knownCharge(c.actualUsd)) throw new Error("unknown, invalid or duplicate search charge");
      chargeIds.add(c.id); total += c.actualUsd; charges.push({ ...c });
    }
    if (total > preflight.perArmSearchBudgetUsd) throw new Error(`equal search allocation exceeded for ${arm}`);
  }
  const now = options.now ?? Date.now;
  const started = now();
  const receipts: PilotReceipt[] = [];
  let stopReason: string | null = null;
  let comparisonIdentity: string | null = null;
  const targetByCase = new Map<string, string>();
  const harnessByArm = new Map<PilotArm, string>();
  // Interleave arms within each paired case/repeat to reduce order confounding.
  outer: for (const c of manifest.cases) for (let repeat = 0; repeat < plan.repeats; repeat++) for (const arm of plan.arms) {
    let measurement: PilotMeasurement | null = null;
    const start = now();
    const result = await runBenchCase({ ...c, passAtK: 1, maxTurns: plan.maxTurns }, {
      scan: async input => {
        measurement = await options.scan({ ...input, attemptIndex: repeat, arm, ceilingUsd: plan.perExecutionCeilingUsd });
        return measurement.report;
      }, oracle: options.oracle, provisioner: options.provisioner, passAtK: 1, attemptPolicy: "independent-repeat", maxTurns: plan.maxTurns,
    });
    const measured = measurement as PilotMeasurement | null;
    const modelUsd = measured?.modelUsd ?? null;
    const computeUsd = measured?.computeUsd ?? null;
    const id = `pilot:${arm}:${c.id}:${repeat}`;
    for (const [category, actualUsd] of [["worker-model", modelUsd], ["compute", computeUsd]] as const) {
      charges.push({ id: `${id}:${category}`, category, actualUsd: knownCharge(actualUsd) ? actualUsd : null });
    }
    receipts.push({ arm, caseId: c.id, ...options.labels[c.id], repeat, result: result.attempts[0], identity: measured?.identity ?? null, invariants: measured?.invariants ?? null, modelUsd, computeUsd, elapsedMs: Math.max(0, now() - start) });
    if (!knownCharge(modelUsd) || !knownCharge(computeUsd)) { stopReason = "unknown actual spend; reconcile before any further dispatch"; break outer; }
    if (!measured || !validIdentity(measured.identity)) { stopReason = "unresolved execution identity"; break outer; }
    if (measured.invariants?.authorityPreserved !== true || measured.invariants?.evidenceValid !== true) { stopReason = "deterministic authority/evidence invariant failed"; break outer; }
    const { harnessDigest, sourceDigest, imageDigest, ...comparableIdentity } = measured.identity;
    const key = hash(comparableIdentity);
    const targetKey = hash({ sourceDigest, imageDigest });
    if ((comparisonIdentity !== null && key !== comparisonIdentity) || (harnessByArm.has(arm) && harnessByArm.get(arm) !== harnessDigest) || (targetByCase.has(c.id) && targetByCase.get(c.id) !== targetKey)) { stopReason = "incompatible runtime provenance across paired executions"; break outer; }
    comparisonIdentity = key;
    harnessByArm.set(arm, harnessDigest);
    targetByCase.set(c.id, targetKey);
    if (modelUsd + computeUsd > plan.perExecutionCeilingUsd) { stopReason = "trusted adapter exceeded execution ceiling"; break outer; }
  }
  const byArm: PilotReport["byArm"] = {};
  for (const arm of plan.arms) {
    const rows = receipts.filter(r => r.arm === arm);
    const times = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
    const positives = rows.filter(r => r.control === "vulnerable");
    const negatives = rows.filter(r => r.control !== "vulnerable");
    byArm[arm] = { verifiedPositives: positives.filter(r => r.result.status === "verified").length, positiveAttempts: positives.length, falseAlarms: negatives.filter(r => r.result.status === "verified").length, negativeAttempts: negatives.length, inconclusives: rows.filter(r => r.result.status === "inconclusive").length, p50Ms: times.length >= 2 ? times[Math.ceil(times.length * .5) - 1] : null, p95Ms: times.length >= 100 ? times[Math.ceil(times.length * .95) - 1] : null };
  }
  return { schemaVersion: 1, planDigest: hash(plan), status: stopReason ? "inconclusive" : "completed-for-review", stopReason, receipts, charges, knownSpendUsd: charges.reduce((s, c) => s + (c.actualUsd ?? 0), 0), unknownCharges: charges.filter(c => c.actualUsd === null).length, elapsedMs: Math.max(0, now() - started), byArm, automaticPromotion: false };
}
