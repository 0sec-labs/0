import type { Finding, FindingWorkflowStatus, LayerVerdict, PocStep } from "@0/shared";
import type { InferSelectModel } from "drizzle-orm";
import { restoreFindingReviewFields } from "@0/db";
import type * as dbSchema from "@0/db";
import { parseImpactAssessment } from "../triage/impact-assessment.js";

/**
 * Strict shape of a persisted findings-table row, inferred directly from
 * the drizzle schema. We thread this through `restorePersistedFinding`
 * (rather than `any`) so the *next* column added to `schema.findings`
 * fails to compile in the rehydrator instead of being silently dropped
 * on resume. See 0#414 / 0#382 — historical regressions where
 * `verificationSpec`, `pocSteps`, `layerVerdicts`, `pocExecution`, the
 * `workflow*` fields, and `score` were each added to the writer/schema
 * but never threaded back through the loader.
 */
type PersistedFindingRow = InferSelectModel<typeof dbSchema.findings>;
/**
 * Same shape as the strict drizzle row, but with JSON-text columns also
 * permitted as their already-parsed object form. Cloud sinks and the
 * in-memory test doubles hand back the parsed objects directly; production
 * SQLite rows are always strings.
 */
export type RestorablePersistedFindingRow = Omit<
  PersistedFindingRow,
  "verificationSpec" | "pocSteps" | "layerVerdicts" | "impactAssessment" | "pocExecution" | "semanticDedupe"
  | "verificationResult" | "reviewAnnotation"
> & {
  verificationResult?: PersistedFindingRow["verificationResult"] | Finding["verification_result"];
  reviewAnnotation?: PersistedFindingRow["reviewAnnotation"] | Record<string, unknown>;
  verificationSpec: PersistedFindingRow["verificationSpec"] | Finding["verificationSpec"];
  pocSteps: PersistedFindingRow["pocSteps"] | Finding["pocSteps"];
  layerVerdicts: PersistedFindingRow["layerVerdicts"] | Finding["layerVerdicts"];
  impactAssessment: PersistedFindingRow["impactAssessment"] | Finding["impactAssessment"];
  pocExecution: PersistedFindingRow["pocExecution"] | Finding["pocExecution"];
  semanticDedupe: PersistedFindingRow["semanticDedupe"] | Finding["semanticDedupe"];
};

/**
 * Parse a JSON-text column from a persisted row. Returns the parsed value
 * when the column is a non-empty string of valid JSON, the value itself
 * when it is already an object (sink-shim / test-double path), or
 * `undefined` otherwise. Malformed JSON is non-fatal: the finding still
 * restores, just without that field. See 0#414.
 */
function parseJsonColumn<T>(value: string | T | null | undefined): T | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    if (value.length === 0) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  // Already-parsed object handed in by a shim/test double.
  return value;
}

/**
 * Rehydrate the `impactAssessment` JSON column through the module's own
 * validated parser, so an out-of-vocabulary tier or a legacy row degrades to
 * `undefined` rather than leaking a malformed assessment into the Finding.
 * Accepts both the DB string form and an already-parsed object (test shims).
 */
function parseImpactAssessmentColumn(
  value: RestorablePersistedFindingRow["impactAssessment"],
): Finding["impactAssessment"] {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length === 0) return undefined;
  return parseImpactAssessment(text) ?? undefined;
}

function parseSemanticDedupe(
  value: RestorablePersistedFindingRow["semanticDedupe"],
): Finding["semanticDedupe"] {
  const parsed = parseJsonColumn<Finding["semanticDedupe"]>(value);
  if (
    !parsed ||
    typeof parsed.canonicalId !== "string" ||
    typeof parsed.isCanonical !== "boolean" ||
    typeof parsed.clusterId !== "string" ||
    typeof parsed.reason !== "string"
  ) {
    return undefined;
  }
  return parsed;
}

/**
 * Rehydrate a persisted findings-table row into a {@link Finding}.
 *
 * Exported for tests so the wire round-trip (verificationSpec, evidence,
 * triage flags, etc.) can be exercised without a full pipeline run.
 * Production callers reach this through the `getFindings(...).map(...)`
 * inside `runPipeline`.
 */
export function restorePersistedFinding(row: RestorablePersistedFindingRow): Finding {
  // 0#193 — `verificationSpec` is the deterministic re-check contract
  // produced by the OSS engine and consumed by cloud's canary watcher.
  // It is persisted as JSON text and must be threaded through every
  // reload path; otherwise findings restored from storage silently lose
  // the contract before cloud re-checks can run.
  let verificationSpec: Finding["verificationSpec"];
  if (typeof row.verificationSpec === "string" && row.verificationSpec.length > 0) {
    try {
      const parsed = JSON.parse(row.verificationSpec);
      // Defensive: only accept the shape we expect. Older rows that
      // stored something malformed get dropped silently rather than
      // breaking the resume path.
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.code)) {
        verificationSpec = parsed;
      }
    } catch {
      // Malformed JSON in the column is non-fatal; the finding still
      // restores, just without a verification contract.
    }
  } else if (row.verificationSpec && typeof row.verificationSpec === "object") {
    // Some shims (cloud sinks, in-memory test doubles) hand back the
    // already-parsed object. Pass it through unchanged.
    if (Array.isArray(row.verificationSpec.code)) {
      verificationSpec = row.verificationSpec;
    }
  }

  // 0#414 — mirror the verificationSpec thread for every other
  // JSON-text column the writer persists. Each defaults to `undefined`
  // when missing or malformed; the typed `RestorablePersistedFindingRow`
  // parameter ensures any new column added to the schema fails to
  // compile here instead of being dropped.
  const pocSteps = parseJsonColumn<PocStep[]>(row.pocSteps);
  const layerVerdicts = parseJsonColumn<LayerVerdict[]>(row.layerVerdicts);
  const impactAssessment = parseImpactAssessmentColumn(row.impactAssessment);
  const pocExecution = parseJsonColumn<Finding["pocExecution"]>(row.pocExecution);
  const semanticDedupe = parseSemanticDedupe(row.semanticDedupe);
  const persistedFindingRank = row.findingRank;
  const findingRank =
    typeof persistedFindingRank === "number" &&
    Number.isSafeInteger(persistedFindingRank) &&
    persistedFindingRank > 0
      ? persistedFindingRank
      : undefined;

  return {
    id: row.id,
    templateId: row.templateId,
    title: row.title,
    description: row.description,
    severity: row.severity as Finding["severity"],
    category: row.category as Finding["category"],
    status: row.status as Finding["status"],
    fingerprint: row.fingerprint ?? undefined,
    triageStatus: row.triageStatus as Finding["triageStatus"],
    triageNote: row.triageNote ?? undefined,
    // 0#414 — workflow + score fields were persisted by saveFinding
    // but silently dropped on resume. Thread the scalar columns directly.
    workflowStatus: (row.workflowStatus ?? undefined) as FindingWorkflowStatus | undefined,
    workflowAssignee: row.workflowAssignee ?? undefined,
    workflowUpdatedAt: row.workflowUpdatedAt ?? undefined,
    score: row.score ?? undefined,
    confidence: row.confidence ?? undefined,
    cvssVector: row.cvssVector ?? undefined,
    cvssScore: row.cvssScore ?? undefined,
    evidence: {
      request: row.evidenceRequest,
      response: row.evidenceResponse,
      analysis: row.evidenceAnalysis ?? undefined,
    },
    layerVerdicts,
    ...(impactAssessment ? { impactAssessment } : {}),
    pocSteps,
    verificationSpec,
    pocExecution,
    ...(semanticDedupe ? { semanticDedupe } : {}),
    ...(findingRank !== undefined ? { findingRank } : {}),
    // 0#420 — `verification_result` and `reviewAnnotation` are the two
    // inputs the source-fix eligibility check reads. They were persisted
    // by the writer but had no columns until now; without threading them
    // back here every reloaded finding reports "not reproduced" and the
    // fix action can never run. `restoreFindingReviewFields` omits a key
    // entirely when absent, so nothing becomes a truthy empty object that
    // could be mistaken for a real verification result.
    ...restoreFindingReviewFields(row),
    timestamp: row.timestamp,
  };
}
