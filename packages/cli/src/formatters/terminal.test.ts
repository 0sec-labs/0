import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@0/shared";
import { formatTerminal } from "./terminal.js";

describe("terminal business priority", () => {
  it("leads with assessed business impact across technical severities and makes unknown context visible", () => {
    const report = { target: "https://example.test", scanDepth: "default", startedAt: "2026-10-02T00:00:00Z", completedAt: "2026-10-02T00:00:01Z", durationMs: 1000, warnings: [], summary: { totalFindings: 2, totalAttacks: 2, critical: 1, high: 0, medium: 0, low: 1, info: 0 }, findings: [
      { id: "critical", templateId: "critical", timestamp: 0, title: "CriticalWithoutContext", severity: "critical", category: "sql-injection", status: "confirmed", description: "Technical issue", evidence: { request: "", response: "", analysis: "" } },
      { id: "low", templateId: "low", timestamp: 0, title: "LowWithProductionImpact", severity: "low", cvssScore: 3.1, category: "sql-injection", status: "confirmed", description: "Workflow bypass", evidence: { request: "", response: "", analysis: "" }, impactAssessment: { reachability_tier: "remote-unauth", weaponizability: "integrity-tampering", blast_radius: "Production payment approvals", business_impact: "headline", assessment_source: "provided", rationale: "Unauthenticated access bypasses production payment approvals." } },
    ] as Finding[] } as ScanReport;
    const output = formatTerminal(report);
    expect(output.indexOf("LowWithProductionImpact")).toBeLessThan(output.indexOf("CriticalWithoutContext"));
    expect(output).toContain("Business priority: Urgent");
    expect(output).toContain("Business priority: Not assessed");
    expect(output).toContain("Business impact rationale:");
    expect(output).toContain("Technical severity:");
    expect(output).toContain("CVSS: 3.1");
    expect(report.findings[0]!.id).toBe("critical");
  });
});
