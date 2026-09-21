// Report-time finding enrichment, extracted verbatim from agentic-scanner.ts
// (S3 god-module cleanup). These helpers were private to agentic-scanner.ts and
// are re-imported there; behaviour is unchanged. Kept as a focused module so
// future enrichment work has somewhere small to grow instead of the monolith.
import type { Finding, PipelineEvent } from "@0/shared";
import type { NativeRuntime } from "../runtime/types.js";
import { mapWithConcurrency } from "../concurrency.js";
import {
  generateRemediation,
  generateRemediationWithLLM,
} from "../remediation.js";
import type { RemediationObservation } from "../remediation.js";
import { assessImpact } from "../triage/impact-assessment.js";

/**
 * How many model-written remediation calls may be in flight at once.
 *
 * The static knowledge-base path is a synchronous map lookup, so the call sites
 * are plain `for` loops. Swapping in an LLM call would turn those into one
 * sequential round-trip per finding — a 50-finding scan would serialise 50
 * model calls at report-assembly time, after the user already believes the scan
 * is done. Bounded fan-out keeps the wall-clock flat without letting a noisy
 * scan open an unbounded number of sessions. Override with
 * `ZERO_REMEDIATION_CONCURRENCY`.
 */
const REMEDIATION_CONCURRENCY = 4;

function remediationConcurrency(): number {
  const raw = process.env["ZERO_REMEDIATION_CONCURRENCY"];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return REMEDIATION_CONCURRENCY;
}

/**
 * Attach remediation guidance to every finding that should carry it.
 *
 * Default path is the static knowledge base — a synchronous category lookup,
 * byte-identical to the behaviour before the LLM path was wired. When
 * `ZERO_FEATURE_LLM_REMEDIATION` is on AND a live runtime is actually
 * reachable, each finding instead gets model-written guidance that can cite its
 * own evidence rather than a generic category snippet.
 *
 * Two properties this function is responsible for:
 *
 *  - **Never regress on a keyless run.** `generateRemediationWithLLM` is
 *    fail-open: with no credentials it quietly returns the KB answer for every
 *    finding, which looks identical to success. So availability is checked here
 *    rather than discovered per-call, and the outcome is logged — a 100%
 *    fallback rate is a misconfiguration, and it must be visible as one.
 *  - **Do not spend silently.** The LLM path bills tokens that the scan's
 *    stage-level cost accounting does not see, so the observed usage is summed
 *    and logged explicitly instead of vanishing.
 *
 * `select` decides which findings are eligible; callers differ on that.
 */
export async function attachRemediation(
  findings: Finding[],
  select: (f: Finding) => boolean,
  deps: {
    llmEnabled: boolean;
    runtime: NativeRuntime | null;
    // Structural rather than the file's usual `db: any` — this helper needs
    // exactly one method, and using the real event type keeps the payload
    // shape checked instead of silently accepting a malformed event.
    db: { logEvent: (event: Omit<PipelineEvent, "id">) => unknown } | null;
    scanId: string;
    stage: string;
  },
): Promise<void> {
  const targets = findings.filter(select);
  if (targets.length === 0) return;

  if (!deps.llmEnabled || !deps.runtime) {
    for (const finding of targets) finding.remediation = generateRemediation(finding);
    return;
  }

  let llmCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const fallbackReasons: Record<string, number> = {};

  await mapWithConcurrency(targets, remediationConcurrency(), async (finding) => {
    const onObservation = (observation: RemediationObservation): void => {
      if (observation.source === "llm") llmCount++;
      else if (observation.fallbackReason) {
        fallbackReasons[observation.fallbackReason] =
          (fallbackReasons[observation.fallbackReason] ?? 0) + 1;
      }
      inputTokens += observation.usage?.inputTokens ?? 0;
      outputTokens += observation.usage?.outputTokens ?? 0;
    };
    // Never let an enrichment failure take down report assembly: the finding
    // is already confirmed, and shipping it with KB guidance beats losing it.
    try {
      finding.remediation = await generateRemediationWithLLM(finding, deps.runtime!, { onObservation });
    } catch {
      finding.remediation = generateRemediation(finding);
      fallbackReasons["error"] = (fallbackReasons["error"] ?? 0) + 1;
    }
  });

  deps.db?.logEvent({
    scanId: deps.scanId,
    stage: deps.stage,
    eventType: "llm_remediation",
    payload: {
      findings: targets.length,
      llm: llmCount,
      baseline: targets.length - llmCount,
      fallbackReasons,
      inputTokens,
      outputTokens,
    },
    timestamp: Date.now(),
  });
}

/**
 * Populate `finding.impactAssessment` for eligible findings.
 *
 * Gated on `ZERO_FEATURE_IMPACT_ASSESSMENT` and a reachable runtime. `assessImpact`
 * is total (never throws; falls back to the deterministic heuristic when no
 * model is available), so the only failure mode to guard here is the wave
 * itself. Bounded fan-out shares the remediation concurrency knob — both are
 * per-finding report-time LLM calls with the same cost profile.
 */
export async function attachImpactAssessment(
  findings: Finding[],
  select: (f: Finding) => boolean,
  deps: { enabled: boolean; runtime: NativeRuntime | null; db: { logEvent: (event: Omit<PipelineEvent, "id">) => unknown } | null; scanId: string; stage: string },
): Promise<void> {
  if (!deps.enabled || !deps.runtime) return;
  const targets = findings.filter(select);
  if (targets.length === 0) return;

  await mapWithConcurrency(targets, remediationConcurrency(), async (finding) => {
    try {
      finding.impactAssessment = await assessImpact(finding, { runtime: deps.runtime! });
    } catch {
      // assessImpact is already total; this is belt-and-suspenders so a
      // surprise never takes down report assembly for a confirmed finding.
    }
  });

  const assessed = targets.filter((f) => f.impactAssessment).length;
  deps.db?.logEvent({
    scanId: deps.scanId,
    stage: deps.stage,
    eventType: "impact_assessment",
    payload: { findings: targets.length, assessed },
    timestamp: Date.now(),
  });
}

/**
 * Count distinct `FLAG{...}` matches across a finding set. Used by
 * `emitScanCompleted` to derive `cost_per_flag` for the
 * `scan_completed` event (0#231).
 *
 * Mirrors the regex in `agent/flag-validator.ts` (`FLAG_WRAPPER_RE`)
 * so anything the validator would accept counts here. Walks
 * `title` / `description` / evidence fields — the agent normally
 * commits a flag into one of these when `save_finding` fires after a
 * successful exploit. Dedupes by inner content so retries that save the
 * same flag twice don't double-count.
 *
 * Note: this does NOT validate flag shape — a decoy `FLAG{Im_a_Script_Kiddie}`
 * would still increment the counter. The triage pipeline already
 * downgrades decoy flags to `false-positive` / `info`; the cost-per-flag
 * metric is honest about cost-per-claimed-flag, not cost-per-real-flag.
 * Cleaner separation than guessing which findings are "real" here.
 */
const FLAG_PATTERN = /FLAG\{([^}]+)\}/gi;
export function countFlagsInFindings(findings: Finding[]): number {
  if (!Array.isArray(findings) || findings.length === 0) return 0;
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f) continue;
    const haystack = [
      typeof f.title === "string" ? f.title : "",
      typeof f.description === "string" ? f.description : "",
      typeof f.evidence?.request === "string" ? f.evidence.request : "",
      typeof f.evidence?.response === "string" ? f.evidence.response : "",
      typeof f.evidence?.analysis === "string" ? f.evidence.analysis : "",
    ].join("\n");
    const matches = haystack.matchAll(FLAG_PATTERN);
    for (const m of matches) {
      // Normalize on inner content so `FLAG{abc}` and `flag{abc}` collapse.
      const inner = (m[1] ?? "").trim().toLowerCase();
      if (inner) seen.add(inner);
    }
  }
  return seen.size;
}
