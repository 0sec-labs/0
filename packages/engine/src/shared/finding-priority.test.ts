import { describe, expect, it } from "vitest";
import { compareFindingsBySeverity, isHeuristicImpactAssessment } from "./finding-priority.js";

describe("finding order", () => {
  it("puts the most severe first, then the higher CVSS score, and ignores the impact assessment", () => {
    const rows = [
      { id: "low", severity: "low", cvssScore: 9.9 },
      { id: "high-scored", severity: "high", cvssScore: 8.1 },
      { id: "high-plain", severity: "high" },
      { id: "critical", severity: "critical", impactAssessment: { business_impact: "noise" } },
      { id: "unknown", severity: "weird" },
    ];
    expect([...rows].sort(compareFindingsBySeverity).map(row => row.id)).toEqual(["critical", "high-scored", "high-plain", "low", "unknown"]);
    expect(rows[0]!.id).toBe("low");
  });
  it("tells a heuristic assessment from a real one", () => {
    const base = { reachability_tier: "remote-auth", blast_radius: "Tenant data", weaponizability: "info-leak", business_impact: "unassessed", rationale: "Other tenants' records are readable." } as const;
    expect(isHeuristicImpactAssessment({ ...base })).toBe(false);
    expect(isHeuristicImpactAssessment({ ...base, assessment_source: "heuristic" })).toBe(true);
    expect(isHeuristicImpactAssessment({ ...base, rationale: "Deterministic fallback derived from severity + category." })).toBe(true);
    expect(isHeuristicImpactAssessment({ ...base, blast_radius: "Heuristic baseline for a SQL injection" })).toBe(true);
  });
});
