/** Business-impact assessment is evidence/context dependent, independent of CVSS.
 * Missing model/context returns an explicitly unassessed record, never a severity-derived business tier.
 */

import type {
  BusinessImpact,
  Finding,
  ImpactAssessment,
} from "@0/shared";
import { compareFindingsByBusinessPriority, getFindingPriority, ImpactAssessmentSchema } from "@0/shared";
import type { NativeRuntime } from "../runtime/types.js";

// ────────────────────────────────────────────────────────────────────
// Vocabularies (single source of truth for validation + ranking)
// ────────────────────────────────────────────────────────────────────

/**
 * Business-priority ordering weight, never money or technical severity. Unknown
 * context remains visible between high and moderate assessed consequences.
 */
export const BUSINESS_IMPACT_RANK: Record<BusinessImpact, number> = {
  headline: 3,
  notable: 2,
  modest: 1,
  noise: 0,
  unassessed: 1.5,
};

// ────────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────────

export interface AssessImpactOptions {
  /**
   * The model, routed through the shared runtime (no raw keys). Injected so
   * tests can pass a fake NativeRuntime. When omitted, {@link assessImpact}
   * returns an explicitly unassessed fallback (no network).
   */
  runtime?: NativeRuntime;
}

// ────────────────────────────────────────────────────────────────────
// Prompt
// ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Assess the evidenced BUSINESS consequences of this security finding. Technical severity and CVSS describe technical conditions; they are not business priority.
Consider exposure of customer or employee data, cross-tenant access, account takeover, unauthorized payments or fraud, integrity of revenue-critical workflows, disruption of critical services, recovery effort, and evidenced downtime. Identify the actual deployment, users/assets affected, attacker prerequisites, and concrete consequence. A bounded crash in an unused tool may be low priority despite high CVSS; exposure of customer records may deserve urgent attention despite a lower score.
Do not invent revenue, monetary loss, deployed reachability, RCE, customer counts, or an outage from a category or severity label. SQL injection is not proof of code execution. Separate observed evidence from assumptions and explicitly identify unknown business context. Privileged prerequisites do not automatically erase a demonstrated business consequence.
Return only JSON:
{"reachability_tier":"remote-unauth|remote-auth|proximity-rf|local-unpriv|local-priv|needs-hardware|needs-host-migration|unknown", "blast_radius":"evidenced affected users/assets; unknown when not established", "weaponizability":"dos-crash|info-leak|integrity-tampering|lpe-to-root|rce|unknown", "business_impact":"headline|notable|modest|noise|unassessed", "rationale":"business consequence, supporting evidence, assumptions and missing context"}
Use a single enum value, not the pipe-delimited alternatives. headline means evidenced urgent business consequence; notable means evidenced substantial consequence; modest means bounded consequence; noise means evidenced minimal consequence, never missing context. Use unassessed when evidence/context is insufficient to assess business consequences. Reachability and attacker gains may independently remain unknown. Preserve uncertainty; a model assessment is advisory, not proof.`;

function buildUserMessage(finding: Finding): string {
  const evidence = finding.evidence;
  const parts = [
    `Title: ${finding.title}`,
    `Category: ${finding.category}`,
    `Technical severity (context only): ${finding.severity}`,
  ];
  if (typeof finding.confidence === "number") {
    parts.push(`Agent confidence: ${finding.confidence}`);
  }
  if (typeof finding.cvssScore === "number") {
    parts.push(`CVSS technical context: ${finding.cvssScore}`);
  }
  if (finding.cvssVector) parts.push(`CVSS vector: ${finding.cvssVector}`);
  parts.push(`Description: ${finding.description}`);
  if (finding.impactAssessment) parts.push(`Reported impact context: ${JSON.stringify(finding.impactAssessment)}`);
  if (evidence?.analysis) {
    parts.push(`Analysis: ${evidence.analysis.slice(0, 1200)}`);
  }
  parts.push(
    "",
    "Assess the real business impact of THIS finding. Return only the JSON object.",
  );
  return parts.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Parsing + validation
// ────────────────────────────────────────────────────────────────────

/**
 * Parse + validate a model response into an {@link ImpactAssessment}. Returns
 * null when the text is not valid JSON or any enum field is out of vocabulary —
 * callers fall back to the heuristic. Tolerant of markdown code fences.
 */
export function parseImpactAssessment(text: string): ImpactAssessment | null {
  let jsonStr = text.trim();
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();
  // Fall back to the first {...} block if the model wrapped it in prose.
  if (!jsonStr.startsWith("{")) {
    const brace = jsonStr.match(/\{[\s\S]*\}/);
    if (brace) jsonStr = brace[0];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const validated = ImpactAssessmentSchema.safeParse(parsed);
  return validated.success ? validated.data : null;
}

// ────────────────────────────────────────────────────────────────────
// Explicitly unassessed fallback
// ────────────────────────────────────────────────────────────────────

/** Compatibility fallback explicitly carries no assessed business consequence or technical reachability. */
export function heuristicImpact(_finding: Finding): ImpactAssessment {
  return {
    reachability_tier: "unknown", blast_radius: "Affected users, assets, and deployment context are not assessed.",
    weaponizability: "unknown", business_impact: "unassessed", assessment_source: "heuristic",
    rationale: "Business impact is unassessed: no usable evidence-grounded model assessment is available. Technical severity and category do not establish reachability, attacker gains, or business consequences.",
  };
}

// ────────────────────────────────────────────────────────────────────
// Public API — assessImpact
// ────────────────────────────────────────────────────────────────────

/**
 * Assess the real business impact of a finding.
 *
 * Routes an LLM assessment through the injected {@link NativeRuntime} (no raw
 * keys). Falls back to {@link heuristicImpact} when no runtime is provided, the
 * model is unavailable, or the response is unparseable — so the function is
 * total (never throws, always returns a record; a fallback remains unassessed).
 */
export async function assessImpact(
  finding: Finding,
  options: AssessImpactOptions = {},
): Promise<ImpactAssessment> {
  const runtime = options.runtime;
  if (!runtime) return heuristicImpact(finding);

  try {
    const result = await runtime.executeNative(
      SYSTEM_PROMPT,
      [{ role: "user", content: [{ type: "text", text: buildUserMessage(finding) }] }],
      [], // no tools
    );
    if (result.error) return heuristicImpact(finding);
    const textBlock = result.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return heuristicImpact(finding);
    const parsed = parseImpactAssessment(textBlock.text);
    return parsed ? { ...parsed, assessment_source: "model" } : heuristicImpact(finding);
  } catch {
    return heuristicImpact(finding);
  }
}

// ────────────────────────────────────────────────────────────────────
// Mapping + ranking (persistence + self-prioritization)
// ────────────────────────────────────────────────────────────────────

/**
 * Map an {@link ImpactAssessment} to the value persisted in the
 * `findings.impact_assessment` jsonb column. A field whitelist (not a
 * pass-through) so an over-eager model can't smuggle extra keys into storage.
 */
export function impactAssessmentToColumn(
  assessment: ImpactAssessment,
): ImpactAssessment {
  return {
    reachability_tier: assessment.reachability_tier,
    blast_radius: assessment.blast_radius,
    weaponizability: assessment.weaponizability,
    business_impact: assessment.business_impact,
    rationale: assessment.rationale,
    ...(assessment.assessment_source ? { assessment_source: assessment.assessment_source } : {}),
  };
}

/** Unknown business context is explicit; it never becomes a neutral assessed tier. */
export function businessImpactOf(finding: Finding): BusinessImpact {
  const assessment = finding.impactAssessment;
  // Canonical shared helper excludes legacy deterministic fallbacks as well as new heuristic records.
  return getFindingPriority(finding).assessed ? assessment!.business_impact : "unassessed";
}
export function impactRank(finding: Finding): number {
  return BUSINESS_IMPACT_RANK[businessImpactOf(finding)];
}
/** Canonical business-first ordering; technical severity/CVSS only break equal/unknown priority. */
export function compareByImpactDesc(a: Finding, b: Finding): number {
  return compareFindingsByBusinessPriority(a, b);
}
