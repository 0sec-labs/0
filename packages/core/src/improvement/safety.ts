import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalEvolutionJson } from "./config.js";
import { ensureEvolutionDirectory, readEvolutionArtifact } from "./artifacts.js";
import { acquireEvolutionController } from "./controller-lock.js";
import type { EvolutionCase, EvolutionConfig } from "./types.js";

export type EvolutionCompatibilityStatus = "compatible" | "incompatible" | "unknown";
export interface EvolutionCorpusIdentity { digest: string; cases: number }

/** Controller observations; requested configuration is never resolved-provider evidence. */
export interface EvolutionComparisonIdentity {
  schemaVersion: 1;
  development: EvolutionCorpusIdentity;
  heldOut: EvolutionCorpusIdentity;
  negativeControl: EvolutionCorpusIdentity;
  evaluatorDigest: string;
  evaluatorSemantics: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  provider: string | null;
  harnessRevision: string;
  toolRevision: string;
  sourceRevision: string;
  compatibilityStatus: EvolutionCompatibilityStatus;
}
export interface EvolutionCompatibility { status: EvolutionCompatibilityStatus; reasons: string[] }

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalEvolutionJson(value)).digest("hex")}`;
}
function contentCorpus(cases: readonly EvolutionCase[], lane: EvolutionCase["lane"]): EvolutionCorpusIdentity {
  const entries = cases.filter((entry) => entry.lane === lane)
    .map((entry) => canonicalEvolutionJson({ lane: entry.lane, input: entry.input, expected: entry.expected })).sort();
  return { digest: digest(entries), cases: entries.length };
}
export function evolutionCorpusIdentity(cases: readonly EvolutionCase[]): {
  development: EvolutionCorpusIdentity; heldOut: EvolutionCorpusIdentity; negativeControl: EvolutionCorpusIdentity;
} {
  return { development: contentCorpus(cases, "development"), heldOut: contentCorpus(cases, "held-out"), negativeControl: contentCorpus(cases, "negative-control") };
}
export function createEvolutionComparisonIdentity(
  config: EvolutionConfig, evaluatorDigest: string,
  options: { evaluatorSemantics?: string; resolvedModel?: string | null; provider?: string | null; harnessRevision?: string; toolRevision?: string; sourceRevision?: string } = {},
): EvolutionComparisonIdentity {
  return {
    schemaVersion: 1, ...evolutionCorpusIdentity(config.cases), evaluatorDigest,
    evaluatorSemantics: options.evaluatorSemantics ?? "0-evolution-exact-json-v1",
    requestedModel: config.model ?? null,
    resolvedModel: options.resolvedModel ?? null, provider: options.provider ?? null,
    harnessRevision: options.harnessRevision ?? digest({ command: config.command, buildCommand: config.buildCommand ?? null, backend: config.backend ?? "docker", image: config.image, timeoutMs: config.timeoutMs, memoryMb: config.memoryMb, cpus: config.cpus, maxOutputBytes: config.maxOutputBytes }),
    toolRevision: options.toolRevision ?? digest(canonicalEvolutionJson.toString()),
    sourceRevision: options.sourceRevision ?? evaluatorDigest,
    compatibilityStatus: "unknown",
  };
}
export function compareEvolutionIdentities(left: EvolutionComparisonIdentity, right: EvolutionComparisonIdentity): EvolutionCompatibility {
  const reasons: string[] = [];
  for (const key of ["development", "heldOut", "negativeControl"] as const) {
    if (left[key].digest !== right[key].digest) reasons.push(`${key} corpus differs`);
  }
  for (const [key, label] of [
    ["evaluatorDigest", "evaluator implementation"], ["evaluatorSemantics", "evaluator semantics"],
    ["resolvedModel", "resolved model"], ["provider", "provider"], ["harnessRevision", "harness revision"],
    ["toolRevision", "tool revision"], ["sourceRevision", "source revision"],
  ] as const) {
    if (left[key] !== null && right[key] !== null && left[key] !== right[key]) reasons.push(`${label} differs`);
  }
  if (reasons.length > 0) return { status: "incompatible", reasons };
  if (!left.resolvedModel || !right.resolvedModel || !left.provider || !right.provider) {
    return { status: "unknown", reasons: ["model/provider identity is unresolved"] };
  }
  return { status: "compatible", reasons: [] };
}
export function holdoutExposureIdentity(identity: EvolutionComparisonIdentity): string {
  return digest({ heldOutCorpus: identity.heldOut.digest, evaluator: identity.evaluatorDigest, semantics: identity.evaluatorSemantics });
}
export interface CampaignDispatchReservation {
  id: string; kind: "model" | "evaluation"; reservedCostUsd: number;
  state: "reserved" | "completed" | "unknown"; actualCostUsd: number | null;
  receiptDigest: string | null; createdAt: string; completedAt: string | null;
  ownerPid: number;
}
export interface HoldoutExposureRecord { identity: string; limit: number; consumed: number; reservationIds: string[] }
export interface EvolutionCampaignLedger {
  schemaVersion: 1; campaignKey: string; campaignName: string; comparisonIdentity: EvolutionComparisonIdentity;
  status: "running" | "idle" | "blocked" | "exhausted";
  cumulativeModelCostUsd: number; cumulativeEvaluationCostUsd: number;
  maxModelCostUsd: number; maxEvaluationCostUsd: number;
  reservations: CampaignDispatchReservation[]; exposures: HoldoutExposureRecord[];
  unknownCost: boolean; resumeReason: string; updatedAt: string;
}
const ledgerPath = (root: string): string => join(root, "campaign-ledger.json");
const campaignKey = (identity: EvolutionComparisonIdentity): string => digest({
  development: identity.development.digest, heldOut: identity.heldOut.digest, negativeControl: identity.negativeControl.digest,
  evaluatorDigest: identity.evaluatorDigest, evaluatorSemantics: identity.evaluatorSemantics,
  harnessRevision: identity.harnessRevision, toolRevision: identity.toolRevision, sourceRevision: identity.sourceRevision,
});
function writeLedger(root: string, ledger: EvolutionCampaignLedger): void {
  const path = ledgerPath(root);
  const directory = ensureEvolutionDirectory(dirname(path));
  const temporary = join(directory, `.campaign-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonicalEvolutionJson(ledger), "utf8"); fchmodSync(fd, 0o400); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}
function mutateLedger<T>(root: string, mutate: (ledger: EvolutionCampaignLedger) => T): T {
  ensureEvolutionDirectory(root);
  // The pass owns root/controller.lock. Ledger transactions have their own lease
  // so the durable reservation does not deadlock inside the owning pass.
  const release = acquireEvolutionController(join(root, "campaign"));
  try {
    const ledger = loadEvolutionCampaign(root);
    try { return mutate(ledger); }
    finally { ledger.updatedAt = new Date().toISOString(); writeLedger(root, ledger); }
  } finally { release(); }
}
export function createOrLoadEvolutionCampaign(
  root: string, identity: EvolutionComparisonIdentity, campaignName: string,
  budgets: { maxModelCostUsd: number; maxEvaluationCostUsd: number },
): EvolutionCampaignLedger {
  if (!Number.isFinite(budgets.maxModelCostUsd) || budgets.maxModelCostUsd <= 0
    || !Number.isFinite(budgets.maxEvaluationCostUsd) || budgets.maxEvaluationCostUsd <= 0) {
    throw new Error("campaign budget bounds must be finite and positive");
  }
  ensureEvolutionDirectory(root);
  const release = acquireEvolutionController(join(root, "campaign"));
  try {
    let existing: EvolutionCampaignLedger | undefined;
    try { existing = loadEvolutionCampaign(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const comparison = compareEvolutionIdentities(existing?.comparisonIdentity ?? identity, identity);
    if (comparison.status !== "compatible") throw new Error(`campaign provenance ${comparison.status}: ${comparison.reasons.join("; ")}`);
    identity = { ...identity, compatibilityStatus: comparison.status };
    if (existing) {
      if (existing.campaignKey !== campaignKey(identity)) throw new Error("campaign identity is incompatible with the durable ledger");
      if (!Number.isFinite(existing.maxModelCostUsd) || !Number.isFinite(existing.maxEvaluationCostUsd)) throw new Error("campaign lacks durable budget bounds; operator reconciliation required");
      for (const reservation of existing.reservations) {
        if (reservation.state !== "reserved") continue;
        if (!Number.isSafeInteger(reservation.ownerPid) || reservation.ownerPid <= 0) {
          reservation.state = "unknown"; existing.unknownCost = true; existing.status = "blocked";
          existing.resumeReason = "dispatch owner is unknown; operator reconciliation required";
          continue;
        }
        try { process.kill(reservation.ownerPid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          reservation.state = "unknown";
          existing.unknownCost = true; existing.status = "blocked";
          existing.resumeReason = "interrupted dispatch has unknown cost; operator reconciliation required";
        }
      }
      existing.updatedAt = new Date().toISOString(); writeLedger(root, existing);
      return existing;
    }
    const ledger: EvolutionCampaignLedger = {
      schemaVersion: 1, campaignKey: campaignKey(identity), campaignName, comparisonIdentity: identity,
      status: "idle", cumulativeModelCostUsd: 0, cumulativeEvaluationCostUsd: 0,
      maxModelCostUsd: budgets.maxModelCostUsd, maxEvaluationCostUsd: budgets.maxEvaluationCostUsd,
      reservations: [], exposures: [], unknownCost: false, resumeReason: "new campaign", updatedAt: new Date().toISOString(),
    };
    writeLedger(root, ledger); return ledger;
  } finally { release(); }
}
export function loadEvolutionCampaign(root: string): EvolutionCampaignLedger {
  const ledger = readEvolutionArtifact(ledgerPath(root)) as EvolutionCampaignLedger;
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.reservations) || !Array.isArray(ledger.exposures)
    || !Number.isFinite(ledger.cumulativeModelCostUsd) || ledger.cumulativeModelCostUsd < 0
    || !Number.isFinite(ledger.cumulativeEvaluationCostUsd) || ledger.cumulativeEvaluationCostUsd < 0
    || !Number.isFinite(ledger.maxModelCostUsd) || ledger.maxModelCostUsd <= 0
    || !Number.isFinite(ledger.maxEvaluationCostUsd) || ledger.maxEvaluationCostUsd <= 0
    || ledger.reservations.some((entry) => !entry || typeof entry.id !== "string"
      || !["model", "evaluation"].includes(entry.kind) || !["reserved", "completed", "unknown"].includes(entry.state)
      || !Number.isFinite(entry.reservedCostUsd) || entry.reservedCostUsd <= 0
      || (entry.state === "completed" && (entry.actualCostUsd === null || !Number.isFinite(entry.actualCostUsd) || entry.actualCostUsd < 0)))
    || ledger.exposures.some((entry) => !entry || !Number.isSafeInteger(entry.limit) || entry.limit <= 0
      || !Number.isSafeInteger(entry.consumed) || entry.consumed < 0 || entry.consumed > entry.limit
      || !Array.isArray(entry.reservationIds))) throw new Error("invalid durable campaign ledger");
  return ledger;
}

/** Once a store has durable safety, changing config cannot reset its accounting. */
export function assertEvolutionCampaignMode(config: Pick<EvolutionConfig, "storePath" | "safety">): void {
  if (config.safety?.enabled) return;
  try { loadEvolutionCampaign(config.storePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("durable campaign safety cannot be disabled for this store");
}
export function reserveCampaignDispatch(root: string, kind: "model" | "evaluation", reservedCostUsd: number): CampaignDispatchReservation {
  if (!Number.isFinite(reservedCostUsd) || reservedCostUsd <= 0) throw new Error("dispatch reservation must be finite and positive");
  return mutateLedger(root, (ledger) => {
    if (ledger.unknownCost || ledger.status === "blocked") throw new Error("campaign is blocked pending unknown-cost reconciliation");
    if (ledger.status === "exhausted") throw new Error("campaign budget is exhausted");
    const spent = kind === "model" ? ledger.cumulativeModelCostUsd : ledger.cumulativeEvaluationCostUsd;
    const limit = kind === "model" ? ledger.maxModelCostUsd : ledger.maxEvaluationCostUsd;
    const pending = ledger.reservations.filter((entry) => entry.kind === kind && entry.state === "reserved").reduce((sum, entry) => sum + entry.reservedCostUsd, 0);
    if (spent + pending + reservedCostUsd > limit) throw new Error("campaign budget cannot cover the next bounded dispatch");
    const reservation: CampaignDispatchReservation = { id: randomUUID(), kind, reservedCostUsd, state: "reserved", actualCostUsd: null, receiptDigest: null, createdAt: new Date().toISOString(), completedAt: null, ownerPid: process.pid };
    ledger.reservations.push(reservation); ledger.status = "running"; return reservation;
  });
}
function settleReservation(ledger: EvolutionCampaignLedger, reservation: CampaignDispatchReservation, actualCostUsd: number | null, receiptDigest: string | null): void {
  const preserveExhaustion = ledger.status === "exhausted";
  const preserveProvenanceBlock = ledger.status === "blocked" && !ledger.unknownCost;
  if (actualCostUsd === null || !Number.isFinite(actualCostUsd) || actualCostUsd < 0) {
    reservation.state = "unknown"; ledger.unknownCost = true; ledger.status = "blocked";
    ledger.resumeReason = "provider or execution cost is unknown; operator reconciliation required";
    return;
  }
  reservation.state = "completed"; reservation.actualCostUsd = actualCostUsd; reservation.receiptDigest = receiptDigest; reservation.completedAt = new Date().toISOString();
  if (reservation.kind === "model") ledger.cumulativeModelCostUsd += actualCostUsd;
  else ledger.cumulativeEvaluationCostUsd += actualCostUsd;
  ledger.unknownCost = ledger.reservations.some((entry) => entry.state === "unknown");
  ledger.status = preserveExhaustion ? "exhausted" : preserveProvenanceBlock || ledger.unknownCost ? "blocked"
    : ledger.reservations.some((entry) => entry.state === "reserved") ? "running" : "idle";
  if (ledger.cumulativeModelCostUsd > ledger.maxModelCostUsd || ledger.cumulativeEvaluationCostUsd > ledger.maxEvaluationCostUsd) {
    ledger.status = "exhausted"; ledger.resumeReason = "durable campaign cost ceiling exceeded";
  }
}
export function settleCampaignDispatch(root: string, reservationId: string, actualCostUsd: number | null, receiptDigest: string | null = null): EvolutionCampaignLedger {
  return mutateLedger(root, (ledger) => {
    const reservation = ledger.reservations.find((entry) => entry.id === reservationId);
    if (!reservation) throw new Error("unknown campaign dispatch reservation");
    if (reservation.state !== "reserved") return ledger;
    settleReservation(ledger, reservation, actualCostUsd, receiptDigest); return ledger;
  });
}
export function blockEvolutionCampaign(root: string, reason: string): void {
  mutateLedger(root, (ledger) => {
    ledger.status = "blocked";
    ledger.resumeReason = reason;
  });
}
/** Operator supplies the observed charge and immutable provider/execution receipt digest. */
export function reconcileCampaignDispatch(root: string, reservationId: string, actualCostUsd: number, receiptDigest: string): EvolutionCampaignLedger {
  if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0 || !/^sha256:[a-f0-9]{64}$/.test(receiptDigest)) throw new Error("reconciliation requires a finite charge and immutable receipt digest");
  const release = acquireEvolutionController(root);
  try {
    return mutateLedger(root, (ledger) => {
      const reservation = ledger.reservations.find((entry) => entry.id === reservationId);
      if (!reservation || reservation.state === "completed") throw new Error("reconciliation requires an unresolved dispatch");
      settleReservation(ledger, reservation, actualCostUsd, receiptDigest); ledger.resumeReason = "operator reconciled interrupted dispatch"; return ledger;
    });
  } finally { release(); }
}
export function reserveHoldoutExposure(root: string, identity: EvolutionComparisonIdentity, queries: number, limit: number): HoldoutExposureRecord {
  if (!Number.isSafeInteger(queries) || queries <= 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error("holdout exposure values must be positive integers");
  return mutateLedger(root, (ledger) => {
    const compatibility = compareEvolutionIdentities(ledger.comparisonIdentity, identity);
    if (compatibility.status !== "compatible") throw new Error(`holdout provenance ${compatibility.status}`);
    const key = holdoutExposureIdentity(identity);
    const current = ledger.exposures.find((entry) => entry.identity === key);
    const record = current ?? { identity: key, limit, consumed: 0, reservationIds: [] };
    if (current && record.limit !== limit) throw new Error("holdout exposure limit cannot change without a fresh corpus/evaluator identity");
    if (record.consumed + queries > record.limit) { ledger.status = "exhausted"; ledger.resumeReason = "holdout exposure exhausted; operator must provide a fresh curated holdout"; throw new Error("holdout exposure exhausted"); }
    record.consumed += queries; record.reservationIds.push(randomUUID());
    if (!current) ledger.exposures.push(record); return record;
  });
}
export function campaignPromotionAllowed(root: string, identity?: EvolutionComparisonIdentity): { allowed: boolean; reason?: string } {
  const ledger = loadEvolutionCampaign(root);
  if (ledger.unknownCost || ledger.status === "blocked") return { allowed: false, reason: ledger.unknownCost ? "campaign is blocked pending unknown-cost reconciliation" : ledger.resumeReason };
  if (ledger.reservations.some((entry) => entry.state !== "completed")) return { allowed: false, reason: "campaign has pending or unknown-cost dispatches" };
  if (ledger.status === "exhausted") return { allowed: false, reason: ledger.resumeReason };
  const comparison = compareEvolutionIdentities(ledger.comparisonIdentity, identity ?? ledger.comparisonIdentity);
  if (comparison.status !== "compatible" || identity?.compatibilityStatus === "unknown" || identity?.compatibilityStatus === "incompatible") return { allowed: false, reason: `campaign provenance ${comparison.status}: ${comparison.reasons.join("; ")}` };
  return { allowed: true };
}
export { campaignKey as evolutionCampaignKey };
