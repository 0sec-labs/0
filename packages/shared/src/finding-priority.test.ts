import { describe, expect, it } from "vitest";
import { ImpactAssessmentSchema, compareFindingsByBusinessPriority, getFindingPriority } from "./finding-priority.js";
import type { ImpactAssessment } from "./types.js";

function assessment(business_impact: ImpactAssessment["business_impact"], rationale = "Exposes customer records across tenants in the deployed billing service."): ImpactAssessment {
  return { reachability_tier: "remote-auth", blast_radius: "Customers of the billing service", weaponizability: "info-leak", business_impact, rationale, assessment_source: "provided" };
}

describe("business impact prioritization", () => {
  it("prioritizes customer impact over a larger technical severity/CVSS score", () => {
    const critical = { id: "development-crash", severity: "critical", cvssScore: 9.8, impactAssessment: assessment("noise", "Isolated development fixture; no customer-facing service affected.") };
    const medium = { id: "customer-records", severity: "medium", cvssScore: 5.4, impactAssessment: assessment("headline") };
    expect([critical, medium].sort(compareFindingsByBusinessPriority).map(finding => finding.id)).toEqual(["customer-records", "development-crash"]);
    expect(getFindingPriority(critical).label).toBe("Low");
    expect(getFindingPriority(medium).label).toBe("Urgent");
  });

  it("does not derive business impact from severity or CVSS when context is absent", () => {
    expect(getFindingPriority({ severity: "critical", cvssScore: 10 })).toMatchObject({ assessed: false, label: "Not assessed" });
    expect(getFindingPriority({ impactAssessment: { business_impact: "headline" } }).assessed).toBe(false);
  });

  it("keeps unknown context visible after assessed high priorities and before moderate/low", () => {
    const findings = [
      { id: "low", impactAssessment: assessment("noise") },
      { id: "unknown", severity: "critical" },
      { id: "moderate", impactAssessment: assessment("modest") },
      { id: "high", impactAssessment: assessment("notable") },
      { id: "urgent", impactAssessment: assessment("headline") },
    ];
    expect(findings.sort(compareFindingsByBusinessPriority).map(finding => finding.id)).toEqual(["urgent", "high", "unknown", "moderate", "low"]);
  });

  it("recognizes old severity-derived fallback assessments as unassessed", () => {
    const legacy = { ...assessment("headline"), assessment_source: undefined, rationale: "Deterministic fallback derived from severity + category (no model assessment available)." };
    expect(getFindingPriority({ impactAssessment: legacy }).assessed).toBe(false);
    expect(getFindingPriority({ impactAssessment: { ...assessment("headline"), assessment_source: "heuristic" } }).assessed).toBe(false);
  });

  it("validates unknowns explicitly and strips unrelated producer fields", () => {
    const parsed = ImpactAssessmentSchema.parse({ ...assessment("unassessed"), reachability_tier: "unknown", weaponizability: "unknown", estimatedLoss: 1_000_000 });
    expect(parsed).not.toHaveProperty("estimatedLoss");
    expect(getFindingPriority({ impactAssessment: parsed })).toMatchObject({ assessed: false, label: "Not assessed" });
    expect(ImpactAssessmentSchema.safeParse({ ...assessment("headline"), assessment_source: "certain" }).success).toBe(false);
  });

  it("uses technical severity only for ties and preserves stable order without usable technical scores", () => {
    const impactAssessment = assessment("notable");
    expect(compareFindingsByBusinessPriority({ severity: "medium", cvssScore: 10, impactAssessment }, { severity: "high", cvssScore: 0, impactAssessment })).toBeGreaterThan(0);
    expect(compareFindingsByBusinessPriority({ cvssScore: Number.NaN }, { cvssScore: null })).toBe(0);
    expect(compareFindingsByBusinessPriority({ cvssScore: 100 }, {})).toBe(0);
  });
});
