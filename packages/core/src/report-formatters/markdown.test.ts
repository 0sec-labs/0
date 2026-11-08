import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@0/shared";
import { formatMarkdown } from "./markdown.js";

const report: ScanReport = {
  target: "http://localhost:43100/v1/chat/completions",
  scanDepth: "quick",
  startedAt: "2026-11-08T04:25:12.178Z",
  completedAt: "2026-11-08T04:25:28.495Z",
  durationMs: 16_317,
  warnings: [],
  summary: { totalAttacks: 1, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  findings: [],
};

describe("markdown report", () => {
  it("marks an unsuccessful scan without findings as incomplete instead of clean", () => {
    const markdown = formatMarkdown({ ...report, executionSuccessful: false });
    expect(markdown).toContain("## No Confirmed Vulnerabilities");
    expect(markdown).toContain("Assessment did not complete successfully. Results may be incomplete.");
    expect(markdown).not.toContain("The target passed all tests.");
  });

  it("marks an unsuccessful scan with findings as incomplete", () => {
    const finding = { id: "F-1", title: "Prompt injection", description: "The model followed injected text.", severity: "high", category: "prompt-injection", status: "verified", evidence: { request: "", response: "" } } as Finding;
    const markdown = formatMarkdown({ ...report, executionSuccessful: false, findings: [finding], summary: { ...report.summary, totalFindings: 1, high: 1 } });
    expect(markdown).toContain("## Findings");
    expect(markdown).toContain("Assessment did not complete successfully. Results may be incomplete.");
  });

  it("keeps the clean result for a successful scan without findings", () => {
    const markdown = formatMarkdown({ ...report, executionSuccessful: true });
    expect(markdown).toContain("## No Vulnerabilities Found");
    expect(markdown).toContain("The target passed all tests.");
  });
});
