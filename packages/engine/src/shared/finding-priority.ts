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
export interface FindingBusinessPriority {
  /** Ordering weight, not a monetary estimate or a CVSS score. */
  rank: number;
  label: "Urgent" | "High" | "Moderate" | "Low" | "Not assessed";
  assessed: boolean;
  rationale: string;
}

const UNKNOWN_PRIORITY: FindingBusinessPriority = {
  rank: 1.5,
  label: "Not assessed",
  assessed: false,
  rationale: "Business impact has not been assessed. Establish the affected services, customers, data, and operational consequences.",
};
const PRIORITIES = {
  headline: { rank: 3, label: "Urgent" },
  notable: { rank: 2, label: "High" },
  modest: { rank: 1, label: "Moderate" },
  noise: { rank: 0, label: "Low" },
} as const;

/** Legacy severity/category fallbacks must not become business facts after upgrading. */
export function isHeuristicImpactAssessment(assessment: ImpactAssessment): boolean {
  return assessment.assessment_source === "heuristic"
    || /^deterministic fallback derived from severity\s*\+\s*category/i.test(assessment.rationale)
    || /^heuristic baseline for a /i.test(assessment.blast_radius);
}

export function getFindingPriority(finding: PrioritizableFinding): FindingBusinessPriority {
  const parsed = ImpactAssessmentSchema.safeParse(finding.impactAssessment);
  if (!parsed.success || parsed.data.business_impact === "unassessed" || isHeuristicImpactAssessment(parsed.data)) {
    return { ...UNKNOWN_PRIORITY };
  }
  const priority = PRIORITIES[parsed.data.business_impact];
  return { ...priority, assessed: true, rationale: parsed.data.rationale };
}

const TECHNICAL_SEVERITY: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
function technicalCvss(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10 ? value : -1;
}

/** Business priority first; technical severity only breaks equal-priority ties.
 * Unknown context stays visible between High and Moderate rather than being buried.
 * Does not suppress findings or alter verification, severity, or execution permission.
 */
export function compareFindingsByBusinessPriority(a: PrioritizableFinding, b: PrioritizableFinding): number {
  return getFindingPriority(b).rank - getFindingPriority(a).rank
    || (TECHNICAL_SEVERITY[b.severity?.toLowerCase() ?? ""] ?? -1) - (TECHNICAL_SEVERITY[a.severity?.toLowerCase() ?? ""] ?? -1)
    || technicalCvss(b.cvssScore) - technicalCvss(a.cvssScore);
}
