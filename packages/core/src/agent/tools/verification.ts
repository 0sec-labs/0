// PoC step, verification spec, evidence-path parsing and done-coverage gate helpers.
// Extracted verbatim from ../tools.ts; the public API is re-exported there.
import type { Finding, SourceVerificationSummary, PocStep, VerificationSpec, VerificationCodePredicate, VerificationBehavior, VerificationBehaviorStep } from "@0/shared";
import { pocStepActionSchema, pocStepExpectSchema } from "@0/shared";
import type { ToolResult } from "../types.js";
import { evaluateVerificationSpec } from "../../verification-spec/spec.js";
import { validateFindingDraft, type FindingDraft, type ValidationError } from "../finding-validator.js";

// ── PoC step graph helpers (0#170) ──

export const POC_STEP_KINDS: ReadonlySet<string> = new Set([
  "setup",
  "auth",
  "prerequisite",
  "exploit",
  "verify",
]);
export const POC_ACTION_TYPES: ReadonlySet<string> = new Set(["shell", "http", "docker", "note"]);
export const POC_EXPECT_TYPES: ReadonlySet<string> = new Set([
  "exit-zero",
  "http-status",
  "body-contains",
  "body-matches",
  "file-exists",
]);

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validatePocStep(raw: unknown): PocStep | null {
  if (!isPlainRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : null;
  const summary =
    typeof raw.summary === "string" && raw.summary.trim().length > 0 ? raw.summary.trim() : null;
  const kind = typeof raw.kind === "string" && POC_STEP_KINDS.has(raw.kind) ? raw.kind : null;
  if (!id || !summary || !kind) return null;
  if (!isPlainRecord(raw.action)) return null;
  const actionType = raw.action.type;
  // Validate the full variant payload against the shared discriminated union:
  // stored findings are re-validated strictly on read (fix/disclose/verify
  // paths), so a step with a missing variant field must never persist.
  const action = pocStepActionSchema.safeParse(raw.action);
  if (!action.success) return null;
  const step: PocStep = {
    id,
    kind: kind as PocStep["kind"],
    summary,
    action: action.data as PocStep["action"],
  };
  if (raw.expect != null) {
    // Malformed expect — drop just the predicate, keep the step. The step is
    // still useful for screenshot rendering and advisory prose even without
    // an executable predicate.
    const expect = pocStepExpectSchema.safeParse(raw.expect);
    if (expect.success) step.expect = expect.data as PocStep["expect"];
  }
  return step;
}

// ── Verification spec helpers (0#193) ──
//
// Mirrors the PoC-step parser pattern above: tolerate already-parsed objects
// AND JSON strings, validate strictly, and return null on anything malformed
// so a bad payload from the LLM never blocks the finding from saving.

export const VERIFICATION_PREDICATE_KINDS: ReadonlySet<string> = new Set([
  "file-contains",
  "file-missing-pattern",
  "file-exists",
  "ast-shape",
  "git-diff-applies",
]);

export const FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
export const MAX_VERIFICATION_DIFF_BYTES = 1_000_000;

export const VERIFICATION_BEHAVIOR_EXPECT_LITERALS: ReadonlySet<string> = new Set([
  "success",
  "forbidden",
]);

export function validateVerificationPredicate(
  raw: unknown,
): VerificationCodePredicate | null {
  if (!isPlainRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== "string" || !VERIFICATION_PREDICATE_KINDS.has(kind)) {
    return null;
  }
  if (kind === "git-diff-applies") {
    const diff = raw.diff;
    const baseCommit = raw.baseCommit;
    if (
      typeof diff !== "string" ||
      diff.trim().length === 0 ||
      Buffer.byteLength(diff, "utf8") > MAX_VERIFICATION_DIFF_BYTES ||
      typeof baseCommit !== "string" ||
      !FULL_GIT_OBJECT_ID_RE.test(baseCommit)
    ) {
      return null;
    }
    return { kind: "git-diff-applies", baseCommit, diff };
  }

  const file = raw.file;
  if (typeof file !== "string" || file.length === 0) return null;

  switch (kind) {
    case "file-exists":
      return { kind: "file-exists", file };
    case "file-contains": {
      const pattern = raw.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) return null;
      const flags = typeof raw.flags === "string" ? raw.flags : undefined;
      return flags !== undefined
        ? { kind: "file-contains", file, pattern, flags }
        : { kind: "file-contains", file, pattern };
    }
    case "file-missing-pattern": {
      const pattern = raw.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) return null;
      const flags = typeof raw.flags === "string" ? raw.flags : undefined;
      return flags !== undefined
        ? { kind: "file-missing-pattern", file, pattern, flags }
        : { kind: "file-missing-pattern", file, pattern };
    }
    case "ast-shape": {
      const query = raw.query;
      if (typeof query !== "string" || query.length === 0) return null;
      return { kind: "ast-shape", file, query };
    }
    default:
      return null;
  }
}

export function validateVerificationBehaviorStep(
  raw: unknown,
): VerificationBehaviorStep | null {
  if (!isPlainRecord(raw)) return null;
  const method = raw.method;
  const path = raw.path;
  if (typeof method !== "string" || method.length === 0) return null;
  if (typeof path !== "string" || path.length === 0) return null;
  const expectRaw = raw.expect;
  let expect: VerificationBehaviorStep["expect"];
  if (typeof expectRaw === "string") {
    if (!VERIFICATION_BEHAVIOR_EXPECT_LITERALS.has(expectRaw)) return null;
    expect = expectRaw as "success" | "forbidden";
  } else if (
    isPlainRecord(expectRaw) &&
    typeof expectRaw.status === "number" &&
    Number.isInteger(expectRaw.status)
  ) {
    expect = { status: expectRaw.status };
  } else {
    return null;
  }
  const step: VerificationBehaviorStep = { method, path, expect };
  if ("body" in raw) step.body = raw.body;
  return step;
}

export function validateVerificationBehavior(
  raw: unknown,
): VerificationBehavior | null {
  if (!isPlainRecord(raw)) return null;
  if (!Array.isArray(raw.steps)) return null;
  const steps: VerificationBehaviorStep[] = [];
  for (const item of raw.steps) {
    const step = validateVerificationBehaviorStep(item);
    if (step) steps.push(step);
  }
  if (steps.length === 0) return null;
  return { steps };
}

/**
 * Parse the `verification_spec` LLM tool argument into a VerificationSpec or
 * null. Same wire-shape tolerance as `parsePocStepsArg` (already-parsed
 * object OR JSON string OR garbage → null).
 *
 * Validation rules:
 *  - `code` MUST be an array (possibly empty after dropping malformed
 *    predicates). If it's missing entirely, the spec is rejected.
 *  - Each predicate is validated per-variant; malformed predicates are
 *    dropped silently (one bad predicate doesn't kill the spec).
 *  - `behavior` is optional; if present-but-malformed, the whole spec is
 *    still accepted, with `behavior` dropped.
 *
 * Exported only for unit tests; not part of the public agent surface.
 */
export function parseVerificationSpecArg(raw: unknown): VerificationSpec | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainRecord(parsed)) return null;
  if (!Array.isArray(parsed.code)) return null;

  const code: VerificationCodePredicate[] = [];
  for (const item of parsed.code) {
    const predicate = validateVerificationPredicate(item);
    if (predicate) code.push(predicate);
  }

  const spec: VerificationSpec = { code };
  if (parsed.behavior !== undefined) {
    const behavior = validateVerificationBehavior(parsed.behavior);
    if (behavior) spec.behavior = behavior;
  }

  // A spec with zero usable code predicates AND no behavior is effectively
  // empty — drop it so the finding doesn't carry a meaningless field.
  if (spec.code.length === 0 && !spec.behavior) return null;

  return spec;
}

/**
 * Harness-built verification spec for findings the agent saved without one.
 * Conservative by construction: each predicate is a `file-contains` check
 * that a distinctive code line quoted in the finding's own evidence exists in
 * the cited source file. This cannot confirm exploitability — it confirms
 * the finding describes code that is actually present where the agent says
 * it is, which is the difference between a reviewable lead and a
 * hallucinated one. Returns undefined when the finding cites no paths.
 *
 * Exported only for unit tests.
 */
export function autoVerificationSpec(finding: Finding): VerificationSpec | null {
  const paths: string[] = [];
  const seen = new Set<string>();
  const pushPath = (value: unknown): void => {
    if (typeof value !== "string") return;
    // Source-tree relative paths only: at least one directory component, a
    // known source extension, no scheme/absolute root, bounded length.
    const matches = value.matchAll(
      /(?:[\w@.-]+\/){1,12}[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|php|rb|sql|sh|bash|ya?ml|toml|json|tf|vue|svelte)/g,
    );
    for (const m of matches) {
      const p = m[0];
      if (p.length <= 200 && !p.startsWith("/") && !seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  };
  if (finding.reviewAnnotation?.path) pushPath(finding.reviewAnnotation.path);
  pushPath(finding.evidence?.request);
  pushPath(finding.evidence?.response);
  pushPath(finding.description);
  if (paths.length === 0) return null;

  const escape = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codeLines = (text: unknown): string[] => {
    if (typeof text !== "string") return [];
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 16 && line.length <= 240)
      .filter((line) => /[(){}[\]=;:<>]/.test(line) && !/^\s*(?:https?:|@)/.test(line))
      .map((line) => line.replace(/^\d+[:.)]\s*/, ""))
      .filter((line) => !/^[-*•]/.test(line));
  };
  const lines = [
    ...new Set([...codeLines(finding.evidence?.response), ...codeLines(finding.evidence?.request), ...codeLines(finding.description)]),
  ];
  const code: VerificationCodePredicate[] = [];
  for (const path of paths.slice(0, 3)) {
    for (const line of lines) {
      if (code.length >= 6) break;
      code.push({ kind: "file-contains", file: path, pattern: escape(line) });
    }
    if (code.length >= 6) break;
  }
  return code.length > 0 ? { code } : null;
}

/**
 * Summarize the bounded source evaluator without retaining predicate details.
 * Unavailable or unsupported predicates are counted as inconclusive instead
 * of being described as a non-match.
 */
export async function evaluateSourceVerification(
  spec: VerificationSpec,
  scopePath: string,
): Promise<SourceVerificationSummary> {
  const totalPredicates = spec.code.length;
  const behaviorPending = Boolean(spec.behavior);
  const noSourcePredicates =
    totalPredicates === 0 ||
    !spec.code.some((predicate) => predicate.kind !== "git-diff-applies");

  try {
    const result = await evaluateVerificationSpec(spec, scopePath);
    if (noSourcePredicates) {
      return {
        status: "inconclusive",
        totalPredicates,
        matchedPredicates: 0,
        notMatchedPredicates: 0,
        inconclusivePredicates: totalPredicates,
        behaviorPending,
      };
    }

    const cannotEvaluate =
      /path escapes repo root or is invalid|path resolves outside repo root|file not found or unreadable|invalid regex|not yet implemented|unknown predicate kind|git repository HEAD unavailable|git diff exceeds/i;
    const inconclusivePredicates = result.failedPredicates.filter((predicate) =>
      cannotEvaluate.test(predicate.reason),
    ).length;
    const notMatchedPredicates =
      result.failedPredicates.length - inconclusivePredicates;
    const matchedPredicates =
      totalPredicates - result.failedPredicates.length;
    const status =
      inconclusivePredicates > 0
        ? "inconclusive"
        : result.passed
          ? "matched"
          : "not_confirmed";
    return {
      status,
      totalPredicates,
      matchedPredicates,
      notMatchedPredicates,
      inconclusivePredicates,
      behaviorPending,
    };
  } catch {
    return {
      status: "inconclusive",
      totalPredicates,
      matchedPredicates: 0,
      notMatchedPredicates: 0,
      inconclusivePredicates: totalPredicates,
      behaviorPending,
    };
  }
}

/**
 * Parse the `poc_steps` LLM tool argument into a PocStep[] or null.
 *
 * Tolerates three wire shapes seen from real models:
 *   1. Already-parsed array (some runtimes auto-parse JSON-shaped strings).
 *   2. JSON-encoded string of an array.
 *   3. Anything else / malformed — returns null so the finding still saves
 *      with prose evidence only.
 *
 * Exported only for unit tests; not part of the public agent surface.
 */
export function parsePocStepsArg(raw: unknown): PocStep[] | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const out: PocStep[] = [];
  for (const item of parsed) {
    const step = validatePocStep(item);
    if (step) out.push(step);
  }
  return out.length > 0 ? out : null;
}

// ── Evidence-paths parsing & validation-failure response (0#409) ──

/**
 * Coerce the `evidence_paths` tool arg into the `FindingDraft.evidence`
 * shape the validator expects. Accepts:
 *   - JSON-encoded string of `string[]` (LLM wire format)
 *   - already-parsed `string[]`
 *   - already-shaped `Array<{path: string}>`
 *   - undefined / null / garbage → empty array
 *
 * The validator does the actual path-escape checks; this helper just
 * normalises the shape so the validator sees a uniform list.
 */
export function parseEvidencePathsArg(
  raw: unknown,
): Array<{ path: string }> {
  if (raw == null || raw === "") return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ path: string }> = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      out.push({ path: item });
    } else if (
      item &&
      typeof item === "object" &&
      typeof (item as { path?: unknown }).path === "string"
    ) {
      out.push({ path: (item as { path: string }).path });
    }
  }
  return out;
}

/**
 * Build the `ToolResult` returned to the agent when `validateFindingDraft`
 * rejects a finding. The shape matches the `flag-validator` convention:
 * a structured `output` object with a `kind: "validation_failed"`
 * discriminator the agent can parse, plus a human-readable `error` string
 * for runtimes that surface only the error field. Critically, this is a
 * SOFT failure — the agent should fix the offending field and re-submit.
 */
export function buildValidationFailureResult(
  errors: ValidationError[],
): ToolResult {
  const lines = errors.map((e) => {
    const hint = e.hint ? ` (hint: ${e.hint})` : "";
    return `- ${e.field}: ${e.reason}${hint}`;
  });
  return {
    success: false,
    output: {
      kind: "validation_failed",
      errors,
    },
    error:
      `save_finding rejected: ${errors.length} structural validation error(s). ` +
      `Fix the offending field(s) and re-submit:\n${lines.join("\n")}`,
  };
}

// ── `done`-tool coverage gate (#audit-laziness) ──
//
// Real-world bug: a sub-agent auditing @vercel/og emitted `done` after
// exactly one tool call (`read_file: package.json`), in 11 seconds, with
// 0 findings — the same shape repeated across @vercel/postgres,
// @vercel/kv, @vercel/blob, @vercel/edge-config, @auth0/nextjs-auth0.
// The agent's own summary said it had only looked at the manifest. We
// reject those `done` calls and tell the model to actually inspect the
// source.
//
// The gate only fires for `audit` / `review` roles — attack / discovery /
// verify sub-agents have very different shapes (network probes, not
// source reads) and would false-positive on this heuristic.

export const SOURCE_FILE_RE = /\.(ts|tsx|js|mjs|cjs|jsx|py|rs|go|java|rb|php|c|h|cpp|hpp)$/i;

/**
 * Reasons a `done` call may be rejected by the coverage gate. Returned
 * to the model as a tool_result error so it knows what to do next.
 */
export interface CoverageGateInput {
  /** Distinct source files the agent has successfully read this session. */
  sourceFilesRead: number;
  /** Total non-`done` tool calls (success or failure) this session. */
  totalToolCalls: number;
  /** Milliseconds since the ToolExecutor was constructed. */
  elapsedMs: number;
  /** How many times `done` has already been rejected this session. */
  priorRejections: number;
}

export interface CoverageGateDecision {
  pass: boolean;
  reason?: string;
}

/**
 * Decide whether a `done` call from an audit / review sub-agent has done
 * enough work to be allowed through. Pure function so the policy is
 * unit-testable without spinning up a ToolExecutor.
 *
 * Default thresholds (override via env):
 *   - `ZERO_AUDIT_MIN_COVERAGE_FILES` (default 3): minimum distinct
 *     source files read.
 *   - `ZERO_AUDIT_DONE_GATE=0`: disable the gate entirely.
 *
 * Pass conditions (any of):
 *   1. At least N distinct source files read.
 *   2. Has been running > 60s with >= 5 tool calls (long enough that
 *      `done` likely follows a genuine investigation, not a 1-call bail).
 *   3. The agent has already been rejected twice — accept the third call
 *      so we never deadlock a legitimately-empty audit.
 */
export function evaluateDoneCoverageGate(input: CoverageGateInput, env: NodeJS.ProcessEnv = process.env): CoverageGateDecision {
  // Operator-tunable kill switch.
  if (env["ZERO_AUDIT_DONE_GATE"] === "0" || env["ZERO_AUDIT_DONE_GATE"] === "false") {
    return { pass: true };
  }

  // After two prior rejections, always pass — the agent has seen the
  // message twice and refuses to do more. Don't deadlock.
  if (input.priorRejections >= 2) {
    return { pass: true };
  }

  const minFiles = (() => {
    const raw = env["ZERO_AUDIT_MIN_COVERAGE_FILES"];
    const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 3;
  })();

  if (input.sourceFilesRead >= minFiles) return { pass: true };
  if (input.elapsedMs > 60_000 && input.totalToolCalls >= 5) return { pass: true };

  // Build a model-facing rejection that names the specific deficit.
  const parts: string[] = [];
  parts.push(
    `done rejected: only ${input.sourceFilesRead} distinct source file(s) inspected `
      + `(threshold: ${minFiles}), ${input.totalToolCalls} total tool calls, `
      + `elapsed ${Math.round(input.elapsedMs / 1000)}s.`,
  );
  parts.push(
    "You have not actually audited the source yet — declaring the audit "
      + "complete now produces a 0-finding scan that misses real vulnerabilities. "
      + "Use list_files to map the tree, search_files with literal identifiers to "
      + "trace the public API, then read the relevant source files. "
      + "Then call `done` again.",
  );
  return { pass: false, reason: parts.join(" ") };
}
