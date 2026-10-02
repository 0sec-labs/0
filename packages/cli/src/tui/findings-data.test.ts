import { describe, expect, it } from "vitest";
import { compareFindingRowsByBusinessPriority, findingFromRow, findingRowPriority, groupFindings, type FindingsRow } from "./findings-data.js";

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

describe("native findings business priority", () => {
  it("ranks business consequences before severity and preserves unknown context for assessment", () => {
    const input = [row("moderate", "modest", "critical", 100), row("unknown", undefined, "critical"),
      row("urgent", "headline", "low", 0, "provided"), row("high", "notable", "info"),
      row("heuristic", "headline", "high", 2, "heuristic")];
    expect([...input].sort(compareFindingRowsByBusinessPriority).map((item) => item.id))
      .toEqual(["urgent", "high", "unknown", "heuristic", "moderate"]);
    expect(findingRowPriority(input[4]).label).toBe("Not assessed");
    expect(input[0].id).toBe("moderate");
  });

  it("uses the latest family assessment, without reviving a stale urgent assessment", () => {
    const input = [
      { ...row("stale", "headline", "critical", 1), fingerprint: "same" },
      { ...row("latest", "modest", "critical", 3), fingerprint: "same" },
      row("high", "notable", "low", 2),
    ];
    const groups = groupFindings(input);
    expect(groups.map((item) => item.latest.id)).toEqual(["high", "latest"]);
    expect(groups[1].count).toBe(2);
    expect(groups.slice(0, 1)[0].latest.id).toBe("high");
  });

  it("retains supplementary CVSS data without using it as business impact", () => {
    const stored = { ...row("technical"), cvssScore: 9.8, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" };
    const finding = findingFromRow(stored);
    expect(finding.cvssScore).toBe(9.8);
    expect(finding.cvssVector).toBe(stored.cvssVector);
    expect(findingRowPriority(stored).label).toBe("Not assessed");
  });

  it("keeps malformed persisted JSON unassessed", () => {
    expect(findingRowPriority({ ...row("broken"), impactAssessment: "{" }).assessed).toBe(false);
  });
});
