import { z } from "zod";
import type { ImpactAssessment } from "./types.js";

/** Canonical assessment contract for tools, persisted findings, and every interface. */
export const ImpactAssessmentSchema = z.object({
  reachability_tier: z.enum(["remote-unauth", "remote-auth", "proximity-rf", "local-unpriv", "local-priv", "needs-hardware", "needs-host-migration", "unknown"]),
  blast_radius: z.string().trim().min(1).max(4096),
  weaponizability: z.enum(["dos-crash", "info-leak", "integrity-tampering", "lpe-to-root", "rce", "unknown"]),
  business_impact: z.enum(["headline", "notable", "modest", "noise", "unassessed"]),
  rationale: z.string().trim().min(1).max(8192),
  assessment_source: z.enum(["model", "provided", "heuristic"]).optional(),
}).strip() satisfies z.ZodType<ImpactAssessment>;

export interface PrioritizableFinding {
  severity?: string;
  cvssScore?: number | null;
  impactAssessment?: unknown;
}
/** Legacy severity/category fallbacks must not become impact facts after upgrading. */
export function isHeuristicImpactAssessment(assessment: ImpactAssessment): boolean {
  return assessment.assessment_source === "heuristic"
    || /^deterministic fallback derived from severity\s*\+\s*category/i.test(assessment.rationale)
    || /^heuristic baseline for a /i.test(assessment.blast_radius);
}

const TECHNICAL_SEVERITY: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
function technicalCvss(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10 ? value : -1;
}

/**
 * Most severe first, then the higher CVSS score. Ordering only: it never hides a finding or changes its severity,
 * its verification or what may be executed.
 */
export function compareFindingsBySeverity(a: PrioritizableFinding, b: PrioritizableFinding): number {
  return (TECHNICAL_SEVERITY[b.severity?.toLowerCase() ?? ""] ?? -1) - (TECHNICAL_SEVERITY[a.severity?.toLowerCase() ?? ""] ?? -1)
    || technicalCvss(b.cvssScore) - technicalCvss(a.cvssScore);
}
