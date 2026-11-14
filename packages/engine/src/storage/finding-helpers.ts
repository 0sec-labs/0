// Finding fingerprinting, review-field (de)serialization and workflow-status helpers.
import { and, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Finding, SourceVerificationSummary, VerificationResult } from "../shared/index.js";
import { findingWorkflowStatuses, type FindingWorkflowStatusDB } from "./schema.js";


export function normalizeFingerprintPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/\r/g, "")
    .replace(/:\d+(?::\d+)?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


export function buildFindingFingerprint(target: string, finding: Finding): string {
  const key = [
    normalizeFingerprintPart(target),
    normalizeFingerprintPart(finding.category),
    normalizeFingerprintPart(finding.title),
    normalizeFingerprintPart(finding.evidence.request.split("\n")[0] ?? ""),
  ].join("::");

  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}


/**
 * The scoped source reference persisted in the `reviewAnnotation` column.
 * Structurally identical to the shared `Finding["reviewAnnotation"]`; aliased
 * here so the parsers below have a name to return without importing the
 * whole Finding shape at every call site.
 */
export type FindingReviewAnnotation = NonNullable<Finding["reviewAnnotation"]>;


/**
 * Hydrated form of persisted finding review and source-check columns. Each key
 * is OPTIONAL and omitted entirely when the underlying column is NULL or
 * unusable — never present as an empty object.
 */
export interface PersistedFindingReviewFields {
  verification_result?: VerificationResult;
  reviewAnnotation?: FindingReviewAnnotation;
  sourceVerification?: SourceVerificationSummary;
}


/**
 * ── Persisted `verification_result` / `reviewAnnotation` (source-fix gate) ──
 *
 * Both fields live on the shared `Finding` and gate the TUI `f` source-fix
 * action: it requires `verification_result.status === "reproduced"` AND a
 * scoped source reference (`reviewAnnotation.path`). Before these columns
 * existed the writer silently dropped them, so every finding reloaded from
 * SQLite reported "finding is not reproduced" and the action could never run.
 *
 * The pair below is deliberately symmetric and conservative:
 *
 *   • The writer emits NULL — never `"{}"` — for anything that is not a
 *     usable value, so a reload can never invent a truthy-but-empty result.
 *   • The reader returns `undefined` (key omitted entirely) for NULL, empty
 *     text, malformed JSON, non-objects, and payloads missing the field that
 *     gives them meaning. A false "reproduced" would let the fix action patch
 *     source for an unverified finding, so absence must stay absence.
 *
 * Validation is intentionally structural (no zod at runtime here, keeping
 * @0/engine/storage free of a zod dependency); the authoritative shape check remains
 * `VerificationResultSchema` in @0/engine/shared.
 */

/** A non-null, non-array object — the only shape either column may hold. */
export function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}


export function parseJsonObjectColumn(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    if (value.length === 0) return undefined;
    try {
      return asPlainObject(JSON.parse(value));
    } catch {
      // Malformed JSON is non-fatal: the finding still loads, just without
      // this field. Never fall back to a partial/empty stand-in.
      return undefined;
    }
  }
  // Already-parsed object handed back by a shim / in-memory test double.
  return asPlainObject(value);
}


/**
 * A verification result is only meaningful when it carries a `status`
 * string — every consumer (`isReproduced`, disclosure promotion) keys off it.
 * Anything else is stored as NULL / read back as `undefined`.
 */
export function parseFindingVerificationResult(value: unknown): VerificationResult | undefined {
  const parsed = parseJsonObjectColumn(value);
  if (!parsed || typeof parsed.status !== "string" || parsed.status.length === 0) return undefined;
  return parsed as unknown as VerificationResult;
}


/**
 * A review annotation is only meaningful when it carries a `path` — that is
 * the scoped source reference the fix action patches against.
 */
export function parseFindingReviewAnnotation(value: unknown): FindingReviewAnnotation | undefined {
  const parsed = parseJsonObjectColumn(value);
  if (!parsed || typeof parsed.path !== "string" || parsed.path.length === 0) return undefined;
  return parsed as unknown as FindingReviewAnnotation;
}

/**
 * A source-verification summary is meaningful only when its status, safe
 * predicate counts, and behavior-pending flag agree. Unknown fields are
 * discarded so malformed/forward data cannot leak into a Finding.
 */
export function parseFindingSourceVerification(value: unknown): SourceVerificationSummary | undefined {
  const parsed = parseJsonObjectColumn(value);
  if (!parsed) return undefined;
  const status = parsed.status;
  const totalPredicates = parsed.totalPredicates;
  const matchedPredicates = parsed.matchedPredicates;
  const notMatchedPredicates = parsed.notMatchedPredicates;
  const inconclusivePredicates = parsed.inconclusivePredicates;
  const behaviorPending = parsed.behaviorPending;
  if (
    (status !== "matched" && status !== "not_confirmed" && status !== "inconclusive") ||
    typeof totalPredicates !== "number" ||
    !Number.isSafeInteger(totalPredicates) ||
    totalPredicates < 0 ||
    typeof matchedPredicates !== "number" ||
    !Number.isSafeInteger(matchedPredicates) ||
    matchedPredicates < 0 ||
    typeof notMatchedPredicates !== "number" ||
    !Number.isSafeInteger(notMatchedPredicates) ||
    notMatchedPredicates < 0 ||
    typeof inconclusivePredicates !== "number" ||
    !Number.isSafeInteger(inconclusivePredicates) ||
    inconclusivePredicates < 0 ||
    typeof behaviorPending !== "boolean"
  ) {
    return undefined;
  }
  const countSum = matchedPredicates + notMatchedPredicates + inconclusivePredicates;
  if (!Number.isSafeInteger(countSum) || countSum !== totalPredicates) return undefined;
  if (
    (status === "matched" &&
      (totalPredicates === 0 || matchedPredicates !== totalPredicates || notMatchedPredicates !== 0 || inconclusivePredicates !== 0)) ||
    (status === "not_confirmed" && (notMatchedPredicates === 0 || inconclusivePredicates !== 0)) ||
    (status === "inconclusive" && inconclusivePredicates === 0 && totalPredicates !== 0)
  ) {
    return undefined;
  }
  return {
    status,
    totalPredicates,
    matchedPredicates,
    notMatchedPredicates,
    inconclusivePredicates,
    behaviorPending,
  };
}


export function serializeFindingSourceVerification(value: unknown): string | null {
  const usable = parseFindingSourceVerification(value);
  return usable ? JSON.stringify(usable) : null;
}


export function serializeFindingVerificationResult(value: unknown): string | null {
  const usable = parseFindingVerificationResult(value);
  return usable ? JSON.stringify(usable) : null;
}


export function serializeFindingReviewAnnotation(value: unknown): string | null {
  const usable = parseFindingReviewAnnotation(value);
  return usable ? JSON.stringify(usable) : null;
}


/**
 * Hydrate the persisted review, canonical replay, and source-check columns
 * into the shared `Finding`. Keys are omitted entirely when their columns
 * are absent or unusable, so pre-migration rows remain ordinary findings.
 * Callers building a `Finding` spread these fields over their mapped row:
 * `{ ...mapped, ...db.getFindingReviewFields(id) }`.
 */
export function restoreFindingReviewFields(
  row: {
    verificationResult?: unknown;
    reviewAnnotation?: unknown;
    sourceVerification?: unknown;
  } | null | undefined,
): PersistedFindingReviewFields {
  if (!row) return {};
  const verificationResult = parseFindingVerificationResult(row.verificationResult);
  const reviewAnnotation = parseFindingReviewAnnotation(row.reviewAnnotation);
  const sourceVerification = parseFindingSourceVerification(row.sourceVerification);
  return {
    ...(verificationResult ? { verification_result: verificationResult } : {}),
    ...(reviewAnnotation ? { reviewAnnotation } : {}),
    ...(sourceVerification ? { sourceVerification } : {}),
  };
}


/**
 * When a finding only carries `pocSteps` and no prose evidence, derive the
 * legacy `evidence.{request,response,analysis}` strings from the step graph
 * so older readers (markdown advisory templates that pre-date pocSteps,
 * dashboards that haven't been updated) still see something useful. The
 * structured `pocSteps` field remains the canonical form — this is purely
 * for backwards compatibility on the read path.
 */
export function deriveEvidenceFromPocSteps(finding: Finding): { request: string; response: string; analysis?: string } {
  if (!finding.pocSteps || finding.pocSteps.length === 0) {
    return { request: "", response: "", analysis: undefined };
  }

  const requestParts: string[] = [];
  const responseParts: string[] = [];
  const analysisParts: string[] = [];

  for (const step of finding.pocSteps) {
    const prefix = `[${step.kind}] ${step.summary}`;
    if (step.action.type === "shell") {
      requestParts.push(`${prefix}\n$ ${step.action.cmd}`);
    } else if (step.action.type === "http") {
      requestParts.push(`${prefix}\n${step.action.method.toUpperCase()} ${step.action.url}`);
    } else if (step.action.type === "docker") {
      requestParts.push(`${prefix}\ndocker run ${step.action.image} ${step.action.args.join(" ")}`.trim());
    } else {
      responseParts.push(`${prefix}\n${step.action.text}`);
    }
    if (step.expect) {
      analysisParts.push(`- ${step.id}: expect ${step.expect.type}`);
    }
  }

  return {
    request: requestParts.join("\n\n"),
    response: responseParts.join("\n\n"),
    analysis: analysisParts.length > 0 ? `PoC step expectations:\n${analysisParts.join("\n")}` : undefined,
  };
}


export function normalizeWorkflowStatus(
  value?: string | null,
  fallback?: {
    status?: string | null;
    triageStatus?: string | null;
  },
): FindingWorkflowStatusDB {
  if (value && findingWorkflowStatuses.includes(value as FindingWorkflowStatusDB)) {
    return value as FindingWorkflowStatusDB;
  }

  if (fallback?.triageStatus === "accepted" || fallback?.status === "reported" || fallback?.status === "fixed") {
    return "done";
  }
  if (fallback?.triageStatus === "suppressed" || fallback?.status === "false-positive") {
    return "cancelled";
  }
  if (fallback?.status && ["verified", "confirmed", "scored"].includes(fallback.status)) {
    return "human_review";
  }

  return "backlog";
}


export type WorkflowStatus =
  | "backlog"
  | "todo"
  | "agent_review"
  | "in_progress"
  | "human_review"
  | "blocked"
  | "done"
  | "cancelled";
