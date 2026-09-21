import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalEvolutionJson } from "./config.js";
import { ensureEvolutionDirectory, readEvolutionArtifact } from "./artifacts.js";
import { acquireEvolutionController } from "./controller-lock.js";
import type { EvolutionCase, EvolutionConfig } from "./types.js";

export type EvolutionCompatibilityStatus = "compatible" | "incompatible" | "unknown";

export interface EvolutionCorpusIdentity {
  digest: string;
  cases: number;
}

/** A controller-owned identity. Case labels are intentionally excluded from corpus digests. */
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

export interface EvolutionCompatibility {
  status: EvolutionCompatibilityStatus;
  reasons: string[];
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalEvolutionJson(value)).digest("hex")}`;
}

function contentCorpus(cases: readonly EvolutionCase[], lane: EvolutionCase["lane"]): EvolutionCorpusIdentity {
  // Sorting canonical content makes a case rename, reorder, or object-key reorder
  // unable to reset longitudinal identity. IDs never enter this digest.
  const entries = cases
    .filter((entry) => entry.lane === lane)
    .map((entry) => canonicalEvolutionJson({ lane: entry.lane, input: entry.input, expected: entry.expected }))
    .sort();
  return { digest: digest(entries), cases: entries.length };
}

export function evolutionCorpusIdentity(cases: readonly EvolutionCase[]): {
  development: EvolutionCorpusIdentity;
  heldOut: EvolutionCorpusIdentity;
  negativeControl: EvolutionCorpusIdentity;
} {
  return {
    development: contentCorpus(cases, "development"),
    heldOut: contentCorpus(cases, "held-out"),
    negativeControl: contentCorpus(cases, "negative-control"),
  };
}

export function createEvolutionComparisonIdentity(
  config: EvolutionConfig,
  evaluatorDigest: string,
  options: {
    evaluatorSemantics?: string;
    resolvedModel?: string | null;
    provider?: string | null;
    harnessRevision?: string;
    toolRevision?: string;
    sourceRevision?: string;
  } = {},
): EvolutionComparisonIdentity {
  const corpus = evolutionCorpusIdentity(config.cases);
  return {
    schemaVersion: 1,
    ...corpus,
    evaluatorDigest,
    evaluatorSemantics: options.evaluatorSemantics ?? "0sec-evolution-exact-json-v1",
    requestedModel: config.model ?? null,
    resolvedModel: options.resolvedModel ?? config.model ?? null,
    provider: options.provider ?? null,
    harnessRevision: options.harnessRevision ?? digest({ command: config.command, buildCommand: config.buildCommand ?? null, backend: config.backend ?? "docker", image: config.image, timeoutMs: config.timeoutMs, memoryMb: config.memoryMb, cpus: config.cpus }),
    toolRevision: options.toolRevision ?? digest({ schemaVersion: config.schemaVersion, kind: config.kind }),
    sourceRevision: options.sourceRevision ?? digest({ sourcePaths: [...config.sourcePaths].sort(), editablePaths: [...config.editablePaths].sort(), objective: config.objective }),
    compatibilityStatus: "compatible",
  };
}

export function compareEvolutionIdentities(
  left: EvolutionComparisonIdentity,
  right: EvolutionComparisonIdentity,
): EvolutionCompatibility {
  const reasons: string[] = [];
  const corpusKeys = ["development", "heldOut", "negativeControl"] as const;
  for (const key of corpusKeys) {
    if (left[key].digest !== right[key].digest) reasons.push(`${key} corpus differs`);
  }
  if (left.evaluatorDigest !== right.evaluatorDigest) reasons.push("evaluator implementation differs");
  if (left.evaluatorSemantics !== right.evaluatorSemantics) reasons.push("evaluator semantics differ");
  if (left.requestedModel !== right.requestedModel) reasons.push("requested model differs");
  if (left.resolvedModel !== right.resolvedModel) reasons.push("resolved model differs");
  if (left.provider !== right.provider) reasons.push("provider differs");
  if (left.harnessRevision !== right.harnessRevision) reasons.push("harness revision differs");
  if (left.toolRevision !== right.toolRevision) reasons.push("tool revision differs");
  if (left.sourceRevision !== right.sourceRevision) reasons.push("source revision differs");
  const unresolved = [left.requestedModel, left.resolvedModel, left.provider, right.requestedModel, right.resolvedModel, right.provider].some((value) => value === null);
  if (unresolved && reasons.length === 0) reasons.push("model/provider identity is unresolved");
  return { status: reasons.length === 0 ? "compatible" : "incompatible", reasons };
}

export function holdoutExposureIdentity(identity: EvolutionComparisonIdentity): string {
  return digest({ heldOutCorpus: identity.heldOut.digest, evaluator: identity.evaluatorDigest, semantics: identity.evaluatorSemantics });
}

export interface CampaignDispatchReservation {
  id: string;
  kind: "model" | "evaluation" | "holdout";
  reservedCostUsd: number;
  state: "reserved" | "completed" | "unknown";
  actualCostUsd: number | null;
  receiptDigest: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface HoldoutExposureRecord {
  identity: string;
  limit: number;
  consumed: number;
  reservationIds: string[];
}

export interface EvolutionCampaignLedger {
  schemaVersion: 1;
  campaignKey: string;
  campaignName: string;
  comparisonIdentity: EvolutionComparisonIdentity;
  status: "running" | "idle" | "blocked" | "exhausted";
  cumulativeModelCostUsd: number;
  cumulativeEvaluationCostUsd: number;
  reservations: CampaignDispatchReservation[];
  exposures: HoldoutExposureRecord[];
  unknownCost: boolean;
  resumeReason: string;
  updatedAt: string;
}

const ledgerPath = (root: string): string => join(root, "campaign-ledger.json");
const campaignKey = (identity: EvolutionComparisonIdentity): string => digest({
  development: identity.development.digest,
  heldOut: identity.heldOut.digest,
  negativeControl: identity.negativeControl.digest,
  evaluatorDigest: identity.evaluatorDigest,
  evaluatorSemantics: identity.evaluatorSemantics,
  harnessRevision: identity.harnessRevision,
  toolRevision: identity.toolRevision,
  sourceRevision: identity.sourceRevision,
});

function writeLedger(root: string, ledger: EvolutionCampaignLedger): void {
  const path = ledgerPath(root);
  const directory = ensureEvolutionDirectory(dirname(path));
  const temporary = join(directory, `.campaign-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, canonicalEvolutionJson(ledger), "utf8");
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
}

function mutateLedger<T>(root: string, mutate: (ledger: EvolutionCampaignLedger) => T): T {
  ensureEvolutionDirectory(root);
  const release = acquireEvolutionController(root);
  try {
    let ledger: EvolutionCampaignLedger;
    try { ledger = readEvolutionArtifact(ledgerPath(root)) as EvolutionCampaignLedger; }
    catch { throw new Error("campaign ledger is missing or unreadable; reconcile before spending"); }
    const value = mutate(ledger);
    ledger.updatedAt = new Date().toISOString();
    writeLedger(root, ledger);
    return value;
  } finally { release(); }
}

export function createOrLoadEvolutionCampaign(
  root: string,
  identity: EvolutionComparisonIdentity,
  campaignName = "evolution",
): EvolutionCampaignLedger {
  ensureEvolutionDirectory(root);
  const release = acquireEvolutionController(root);
  try {
    const path = ledgerPath(root);
    try {
      const existing = readEvolutionArtifact(path) as EvolutionCampaignLedger;
      if (existing.campaignKey !== campaignKey(identity)) throw new Error("campaign identity is incompatible with the durable ledger");
      if (existing.comparisonIdentity.heldOut.digest !== identity.heldOut.digest || existing.comparisonIdentity.evaluatorDigest !== identity.evaluatorDigest) {
        throw new Error("campaign corpus/evaluator identity cannot be changed");
      }
      return existing;
    } catch (error) {
      if (error instanceof Error && !error.message.includes("missing") && !error.message.includes("ENOENT")) throw error;
    }
    const ledger: EvolutionCampaignLedger = {
      schemaVersion: 1, campaignKey: campaignKey(identity), campaignName, comparisonIdentity: identity,
      status: "idle", cumulativeModelCostUsd: 0, cumulativeEvaluationCostUsd: 0,
      reservations: [], exposures: [], unknownCost: false, resumeReason: "new campaign", updatedAt: new Date().toISOString(),
    };
    writeLedger(root, ledger);
    return ledger;
  } finally { release(); }
}

export function loadEvolutionCampaign(root: string): EvolutionCampaignLedger {
  return readEvolutionArtifact(ledgerPath(root)) as EvolutionCampaignLedger;
}

export function reserveCampaignDispatch(root: string, kind: "model" | "evaluation", reservedCostUsd: number): CampaignDispatchReservation {
  if (!Number.isFinite(reservedCostUsd) || reservedCostUsd <= 0) throw new Error("dispatch reservation must be finite and positive");
  return mutateLedger(root, (ledger) => {
    if (ledger.unknownCost || ledger.status === "blocked") throw new Error("campaign is blocked pending unknown-cost reconciliation");
    if (ledger.status === "exhausted") throw new Error("campaign budget is exhausted");
    const reservation: CampaignDispatchReservation = { id: randomUUID(), kind, reservedCostUsd, state: "reserved", actualCostUsd: null, receiptDigest: null, createdAt: new Date().toISOString(), completedAt: null };
    ledger.reservations.push(reservation);
    ledger.status = "running";
    return reservation;
  });
}

export function settleCampaignDispatch(root: string, reservationId: string, actualCostUsd: number | null, receiptDigest: string | null = null): EvolutionCampaignLedger {
  return mutateLedger(root, (ledger) => {
    const reservation = ledger.reservations.find((entry) => entry.id === reservationId);
    if (!reservation) throw new Error("unknown campaign dispatch reservation");
    if (reservation.state !== "reserved") return ledger;
    if (actualCostUsd === null || !Number.isFinite(actualCostUsd) || actualCostUsd < 0) {
      reservation.state = "unknown"; ledger.unknownCost = true; ledger.status = "blocked"; ledger.resumeReason = "provider or execution cost is unknown; operator reconciliation required";
    } else {
      reservation.state = "completed"; reservation.actualCostUsd = actualCostUsd; reservation.receiptDigest = receiptDigest; reservation.completedAt = new Date().toISOString();
      if (reservation.kind === "model") ledger.cumulativeModelCostUsd += actualCostUsd;
      if (reservation.kind === "evaluation") ledger.cumulativeEvaluationCostUsd += actualCostUsd;
    }
    return ledger;
  });
}

export function reserveHoldoutExposure(root: string, identity: EvolutionComparisonIdentity, queries: number, limit: number): HoldoutExposureRecord {
  if (!Number.isSafeInteger(queries) || queries <= 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error("holdout exposure values must be positive integers");
  const key = holdoutExposureIdentity(identity);
  return mutateLedger(root, (ledger) => {
    const current = ledger.exposures.find((entry) => entry.identity === key);
    const record = current ?? { identity: key, limit, consumed: 0, reservationIds: [] };
    if (record.limit !== limit && current) throw new Error("holdout exposure limit cannot change without a fresh corpus/evaluator identity");
    if (record.consumed + queries > record.limit) { ledger.status = "exhausted"; ledger.resumeReason = "holdout exposure exhausted; operator must provide a fresh curated holdout"; throw new Error("holdout exposure exhausted"); }
    const reservationId = randomUUID();
    record.consumed += queries;
    record.reservationIds.push(reservationId);
    if (!current) ledger.exposures.push(record);
    return record;
  });
}

export function campaignPromotionAllowed(root: string): { allowed: boolean; reason?: string } {
  const ledger = loadEvolutionCampaign(root);
  if (ledger.unknownCost || ledger.status === "blocked") return { allowed: false, reason: "campaign is blocked pending unknown-cost reconciliation" };
  if (ledger.status === "exhausted") return { allowed: false, reason: ledger.resumeReason };
  return { allowed: true };
}

export { campaignKey as evolutionCampaignKey };
