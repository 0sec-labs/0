// Argument schemas and validators for ask_operator, executor checkpoints and impact assessments.
// Extracted verbatim from ../tools.ts; the public API is re-exported there.
import { randomUUID } from "node:crypto";
import { ImpactAssessmentSchema } from "../../shared/index.js";
import type { OperatorQuestion, OperatorQuestionOption, OperatorQuestionRequest } from "../types.js";
import { todoInputSchema, MAX_TODOS } from "../todos.js";
import { z } from "zod";

export const memoryArgsSchema = z.object({
  action: z.enum(["remember", "update", "forget"]),
  note: z.string().trim().max(2000).optional(),
  kind: z.string().max(40).optional(),
  scope: z.enum(["folder", "global"]).optional(),
  id: z.string().max(64).optional(),
}).strip();

// ── Operator question tool (`ask_operator`) ─────────────────────────────────
//
// Schema bounds for `ask_operator`. Deliberately small: a mid-turn operator
// prompt must be answerable at a glance, not a survey.
export const MIN_OPERATOR_QUESTIONS = 1;
export const MAX_OPERATOR_QUESTIONS = 4;
export const MIN_OPERATOR_OPTIONS = 2;
export const MAX_OPERATOR_OPTIONS = 4;

/** Result of validating + building an {@link OperatorQuestionRequest}. */
export type OperatorQuestionBuildResult =
  | { ok: true; request: OperatorQuestionRequest }
  | { ok: false; error: string };

export function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate raw `ask_operator` tool arguments and build a typed
 * {@link OperatorQuestionRequest}, stamping a generated `requestId`.
 *
 * Pure and side-effect-free (exported for unit tests). The `idFactory` is
 * injectable so tests get a deterministic `requestId`, mirroring how other
 * modules inject id/clock factories. Enforces the schema bounds: 1–4 questions;
 * when a question carries options there must be 2–4, each with a non-empty
 * label. Snake_case tool args (`multi_select` / `allow_custom`) are normalized
 * to the camelCase typed fields.
 *
 * This builder ONLY shapes and validates data — it authorizes nothing.
 */
export function buildOperatorQuestionRequest(
  args: Record<string, unknown>,
  idFactory: () => string = () => randomUUID(),
): OperatorQuestionBuildResult {
  const rawQuestions = args["questions"];
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, error: "ask_operator requires a 'questions' array." };
  }
  if (
    rawQuestions.length < MIN_OPERATOR_QUESTIONS ||
    rawQuestions.length > MAX_OPERATOR_QUESTIONS
  ) {
    return {
      ok: false,
      error: `ask_operator accepts ${MIN_OPERATOR_QUESTIONS}–${MAX_OPERATOR_QUESTIONS} questions (got ${rawQuestions.length}).`,
    };
  }

  const questions: OperatorQuestion[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const raw = rawQuestions[i];
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: `Question ${i + 1} must be an object.` };
    }
    const q = raw as Record<string, unknown>;
    if (!nonEmptyString(q["header"])) {
      return { ok: false, error: `Question ${i + 1} requires a non-empty 'header'.` };
    }
    if (!nonEmptyString(q["question"])) {
      return { ok: false, error: `Question ${i + 1} requires a non-empty 'question'.` };
    }

    const question: OperatorQuestion = {
      header: (q["header"] as string).trim(),
      question: (q["question"] as string).trim(),
    };

    const rawOptions = q["options"];
    if (rawOptions !== undefined) {
      if (!Array.isArray(rawOptions)) {
        return { ok: false, error: `Question ${i + 1} 'options' must be an array.` };
      }
      if (
        rawOptions.length < MIN_OPERATOR_OPTIONS ||
        rawOptions.length > MAX_OPERATOR_OPTIONS
      ) {
        return {
          ok: false,
          error: `Question ${i + 1} must offer ${MIN_OPERATOR_OPTIONS}–${MAX_OPERATOR_OPTIONS} options when present (got ${rawOptions.length}).`,
        };
      }
      const options: OperatorQuestionOption[] = [];
      for (let j = 0; j < rawOptions.length; j++) {
        const rawOpt = rawOptions[j];
        if (typeof rawOpt !== "object" || rawOpt === null) {
          return { ok: false, error: `Question ${i + 1} option ${j + 1} must be an object.` };
        }
        const opt = rawOpt as Record<string, unknown>;
        if (!nonEmptyString(opt["label"])) {
          return {
            ok: false,
            error: `Question ${i + 1} option ${j + 1} requires a non-empty 'label'.`,
          };
        }
        const option: OperatorQuestionOption = { label: (opt["label"] as string).trim() };
        if (nonEmptyString(opt["description"])) {
          option.description = (opt["description"] as string).trim();
        }
        if (typeof opt["recommended"] === "boolean") {
          option.recommended = opt["recommended"] as boolean;
        }
        options.push(option);
      }
      question.options = options;
    }

    // Accept both snake_case (tool schema) and camelCase (defensive).
    const multi = q["multi_select"] ?? q["multiSelect"];
    if (typeof multi === "boolean") question.multiSelect = multi;
    const custom = q["allow_custom"] ?? q["allowCustom"];
    if (typeof custom === "boolean") question.allowCustom = custom;

    questions.push(question);
  }

  return { ok: true, request: { requestId: idFactory(), questions } };
}

export const oastProtocolCheckpointSchema = z.enum(["dns", "http", "smtp", "ldap"]);
export const oastInteractionCheckpointSchema = z.object({
  protocol: oastProtocolCheckpointSchema,
  timestamp: z.string(),
  queryName: z.string(),
  path: z.string().optional(),
  method: z.string().optional(),
  remoteAddress: z.string().optional(),
  raw: z.string().optional(),
}).strict();

/** Data-only handoff ABI. Authority fields are required, never defaulted. */
export const toolExecutorCheckpointSchema = z.object({
  credentialTarget: z.string(),
  rejectedDecoyFlags: z.array(z.string()),
  scopedAuditGrants: z.array(z.string()),
  scopedAuditDenials: z.array(z.string()),
  assignedAgentNames: z.array(z.string()),
  oastHandles: z.array(z.object({
    id: z.string(),
    handle: z.object({
      id: z.string(), token: z.string(), host: z.string(),
      httpUrl: z.string(), dnsHost: z.string(), createdAt: z.string(),
    }).strict(),
  }).strict()),
  oastCandidates: z.array(z.object({ id: z.string(), candidate: z.string() }).strict()),
  oastVerified: z.array(z.object({
    id: z.string(),
    oastClass: z.enum(["blind-ssrf", "blind-xss", "jndi", "oob-rce", "oob-sqli", "xxe-oob"]),
    verdict: z.object({
      verified: z.boolean(), confidence: z.number().min(0).max(1),
      protocol: oastProtocolCheckpointSchema.nullable(),
      evidence: z.string(), reason: z.string(),
      interaction: oastInteractionCheckpointSchema.nullable(),
    }).strict(),
  }).strict()),
  startedAt: z.number().finite().nonnegative(),
  sourceFilesRead: z.array(z.string()),
  totalNonDoneToolCalls: z.number().int().nonnegative(),
  doneRejections: z.number().int().nonnegative(),
  msgDrainTurn: z.number().int().min(-1),
  msgDrainCount: z.number().int().nonnegative(),
  todos: z.object({
    items: z.array(todoInputSchema.required({ status: true }).extend({ id: z.string() }).strict()).max(MAX_TODOS),
    revision: z.number().int().nonnegative(),
  }).strict(),
  toolHealth: z.array(z.object({
    tool: z.string(),
    category: z.enum(["missing-binary", "buffer-limit", "wrong-lockfile", "policy-denied", "scope-denied", "error"]),
    message: z.string(), remedy: z.string().optional(),
    count: z.number().int().positive(),
    firstSeen: z.number().finite(), lastSeen: z.number().finite(),
  }).strict()),
}).strict();

export type ToolExecutorCheckpoint = z.infer<typeof toolExecutorCheckpointSchema>;

// ── Impact-assessment enum validation (0#1103) ─────────────────────────
// Module-level constants (never recreated per call) with safe `hasOwn`
// property lookup to block prototype-pollution via `__proto__` keys.

export const inlineImpactAssessmentSchema = ImpactAssessmentSchema.extend({
  blast_radius: z.string().trim().min(1).max(1000),
  rationale: z.string().trim().min(1).max(1000),
});
