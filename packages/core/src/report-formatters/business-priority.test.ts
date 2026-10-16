import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePdfReport } from "./pdf.js";
import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@0/shared";
import { formatMarkdown } from "./markdown.js";
import { formatHtml } from "./html.js";
import { formatSarif } from "./sarif.js";

function finding(id: string, severity: Finding["severity"], impact?: Finding["impactAssessment"]): Finding {
  return { id, templateId: id, title: id, description: "Observed evidence", severity, category: "sql-injection", status: "confirmed", evidence: { request: "request", response: "response", analysis: "analysis" }, impactAssessment: impact } as Finding;
}
function priorityReport(): ScanReport {
  return { target: "https://example.test", scanDepth: "default", startedAt: "2026-10-02T00:00:00Z", completedAt: "2026-10-02T00:01:00Z", durationMs: 60_000, warnings: [], summary: { totalFindings: 3, totalAttacks: 3, critical: 2, high: 0, medium: 0, low: 1, info: 0 }, findings: [
    finding("TechnicalCriticalLimitedImpact", "critical", { reachability_tier: "local-priv", blast_radius: "Isolated test service", weaponizability: "dos-crash", business_impact: "noise", rationale: "The demonstrated failure is limited to a disposable test service.", assessment_source: "provided" }),
    finding("TechnicalLowBusinessUrgent", "low", { reachability_tier: "remote-unauth", blast_radius: "Production payment approvals", weaponizability: "integrity-tampering", business_impact: "headline", rationale: "An unauthenticated attacker can bypass production payment approvals.", assessment_source: "model" }),
    finding("TechnicalCriticalUnknownImpact", "critical"),
  ] } as ScanReport;
}
describe("business priority report exports", () => {
  it.each([["Markdown", formatMarkdown], ["HTML", formatHtml]] as const)("%s prioritizes business impact across technical severities without changing evidence", (_name, format) => {
    const report = priorityReport();
    const original = report.findings.map(item => item.id);
    const output = format(report);
    expect(output.indexOf("TechnicalLowBusinessUrgent")).toBeLessThan(output.indexOf("TechnicalCriticalLimitedImpact"));
    expect(output).toContain("Business priority");
    expect(output).toContain("Business impact rationale");
    expect(output).toContain("Not assessed");
    expect(output).toContain("Technical severity");
    expect(output).toContain("production payment approvals");
    expect(report.findings.map(item => item.id)).toEqual(original);
  });
  it("SARIF retains technical levels and CVSS while exporting business priority and evidence in priority order", () => {
    const report = priorityReport(); report.findings[0]!.cvssScore = 9.8;
    const results = JSON.parse(formatSarif(report)).runs[0].results;
    expect(results.map((item: { properties: { findingId: string } }) => item.properties.findingId)).toEqual(["TechnicalLowBusinessUrgent", "TechnicalCriticalUnknownImpact", "TechnicalCriticalLimitedImpact"]);
    expect(results[0]).toMatchObject({ level: "note", properties: { severity: "low", businessPriority: "Urgent", businessPriorityAssessed: true } });
    expect(results[2]).toMatchObject({ level: "error", properties: { severity: "critical", cvssScore: 9.8, businessPriority: "Low", evidence: report.findings[0]!.evidence } });
    expect(results[1].properties).toMatchObject({ businessPriority: "Not assessed", businessPriorityAssessed: false });
  });
  it.skipIf(!process.env.ZERO_PRIORITY_PDF_PREVIEW)("PDF renders business priority, rationale and separate technical severity in the same finding order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "0-priority-pdf-"));
    try {
      const path = join(directory, "report.pdf");
      await generatePdfReport(priorityReport(), path);
      const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
      expect(text.indexOf("TechnicalLowBusinessUrgent")).toBeLessThan(text.indexOf("TechnicalCriticalLimitedImpact"));
      expect(text).toContain("Business priority: Urgent");
      expect(text).toContain("Business priority: Not assessed");
      expect(text).toContain("Business impact rationale:");
      expect(text).toContain("Technical severity: Low");
      copyFileSync(path, process.env.ZERO_PRIORITY_PDF_PREVIEW!);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("heuristic impact remains explicitly unassessed even when its legacy tier claims urgency", () => {
    const report = priorityReport(); report.findings = [finding("Heuristic", "critical", { ...report.findings[1]!.impactAssessment!, assessment_source: "heuristic" })];
    expect(formatMarkdown(report)).toContain("Business priority:** Not assessed");
    expect(JSON.parse(formatSarif(report)).runs[0].results[0].properties).toMatchObject({ businessPriority: "Not assessed", businessPriorityAssessed: false });
  });
});
