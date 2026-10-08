import { describe, expect, it } from "vitest";
import { assembleEngagementReport } from "./engagements.js";
import { engagementMarkdown } from "./engagement-report.js";
import type { Finding, ScanReport } from "@0/shared";

describe("engagement report handoff", () => {
  it("preserves evidence, source attribution and coverage warnings in Markdown", () => {
    const finding: Finding = { id: "finding-a", templateId: "fixture", title: "<script>fixture</script>", description: "Fixture", severity: "high", category: "path-traversal", status: "confirmed", timestamp: 1,
      evidence: { request: "GET /fixture", response: "```\n# evidence heading\n```" } };
    const scan = { id: "scan-a", target: "Synthetic fixture", status: "completed", startedAt: "2026-10-08T12:00:00Z", completedAt: null, durationMs: null };
    const source = { target: scan.target, scanDepth: "quick", startedAt: scan.startedAt, completedAt: "", durationMs: 0, findings: [finding], executionSuccessful: false, exitReason: "partial", error: "Model <connection> failed", warnings: [{ stage: "report", message: "Only retained evidence is available" }], summary: { totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0, totalAttacks: 0 } } as ScanReport;
    const report = assembleEngagementReport({ id: "530e1b52-f853-4ce0-bff1-9d6ad390897e", name: "Fixture", description: "Authorized scope", notes: "Review with the team", scanIds: [scan.id], createdAt: scan.startedAt, updatedAt: scan.startedAt }, [{ scan, report: source }]);
    const markdown = engagementMarkdown(report);
    expect(markdown).toContain("Source scan: scan-a · Finding ID: finding-a");
    expect(markdown).toContain("Review with the team");
    expect(markdown).toContain("Only retained evidence is available");
    expect(markdown).toContain("Review status: unreviewed");
    expect(markdown).toContain("Recorded duration (ms): Not recorded");
    expect(markdown).toContain("Execution successful: No");
    expect(markdown).toContain("Exit reason: partial");
    expect(markdown).toContain("Execution error: Model \\<connection\\> failed");
    expect(markdown).toContain("````json");
    expect(markdown).toContain(JSON.stringify(finding, null, 2));
    expect(markdown).not.toContain("### <script>");
    // Large retained evidence can contain more backtick runs than the JS argument limit.
    report.findingGroups[0]!.occurrences[0]!.finding.evidence.response = "` ".repeat(150000);
    expect(() => engagementMarkdown(report)).not.toThrow();
  });
});
