import { describe, expect, it } from "vitest";
import { compareFindingRowsBySeverity, findingFromRow, groupFindings, type FindingsRow } from "./findings-data.js";

function row(id: string, business?: string, severity = "high", timestamp = 1, source?: string): FindingsRow {
  return {
    id, scanId: id, title: id, severity, category: "test", status: "discovered", timestamp,
    templateId: "manual", description: "", evidenceRequest: "", evidenceResponse: "",
    impactAssessment: business ? JSON.stringify({
      reachability_tier: "remote-auth", weaponizability: "info-leak", blast_radius: "Tenant data",
      business_impact: business, rationale: "Affected tenant records are exposed.", assessment_source: source,
    }) : null,
  };
}

describe("native findings order", () => {
  it("puts the most severe first, then the higher CVSS score, then the newest", () => {
    const input = [row("low", undefined, "low", 5), row("critical", undefined, "critical", 1), row("high-old", undefined, "high", 1), row("high-new", undefined, "high", 9)];
    expect([...input].sort(compareFindingRowsBySeverity).map((item) => item.id)).toEqual(["critical", "high-new", "high-old", "low"]);
    const scored = [{ ...row("a", undefined, "high", 1), cvssScore: 5 }, { ...row("b", undefined, "high", 1), cvssScore: 9 }];
    expect([...scored].sort(compareFindingRowsBySeverity).map((item) => item.id)).toEqual(["b", "a"]);
    expect(input[0].id).toBe("low");
  });

  it("groups a family under its latest finding and orders the families by severity", () => {
    const input = [
      { ...row("stale", "headline", "critical", 1), fingerprint: "same" },
      { ...row("latest", "modest", "low", 3), fingerprint: "same" },
      row("high", "notable", "high", 2),
    ];
    const groups = groupFindings(input);
    expect(groups.map((item) => item.latest.id)).toEqual(["high", "latest"]);
    expect(groups[1].count).toBe(2);
  });

  it("retains supplementary CVSS data", () => {
    const stored = { ...row("technical"), cvssScore: 9.8, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" };
    const finding = findingFromRow(stored);
    expect(finding.cvssScore).toBe(9.8);
    expect(finding.cvssVector).toBe(stored.cvssVector);
  });

  it("keeps malformed persisted JSON from breaking a row", () => {
    expect(() => findingFromRow({ ...row("broken"), impactAssessment: "{" })).not.toThrow();
  });
});
