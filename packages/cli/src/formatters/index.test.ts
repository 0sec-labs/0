import { describe, expect, it } from "vitest";
import {
  createAuditReportDocument,
  createScanReportDocument,
  createReviewReportDocument,
  type AuditReport,
  type ScanReport,
  type ReviewReport,
} from "@0/shared";
import {
  formatAuditReport,
  formatPresentationDocument,
  formatReport,
} from "./index.js";

const summary = {
  totalAttacks: 0,
  totalFindings: 0,
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
};

const scan: ScanReport = {
  target: "https://example.test",
  scanDepth: "quick",
  startedAt: "2026-08-26T00:00:00.000Z",
  completedAt: "2026-08-26T00:00:01.000Z",
  durationMs: 1_000,
  summary,
  findings: [],
  warnings: [],
};

const audit: AuditReport = {
  package: "example",
  version: "1.0.0",
  startedAt: "2026-08-26T00:00:00.000Z",
  completedAt: "2026-08-26T00:00:01.000Z",
  durationMs: 1_000,
  semgrepFindings: 0,
  npmAuditFindings: [],
  summary,
  findings: [],
};

describe("formatPresentationDocument", () => {
  it("preserves scan JSON bytes through the canonical document adapter", () => {
    expect(formatPresentationDocument(createScanReportDocument(scan), "json"))
      .toBe(formatReport(scan, "json"));
  });

  it("preserves audit JSON bytes through the canonical document adapter", () => {
    expect(formatPresentationDocument(createAuditReportDocument(audit), "json"))
      .toBe(JSON.stringify(audit, null, 2));
    expect(formatAuditReport(audit, "json"))
      .toBe(JSON.stringify(audit, null, 2));
  });

  it("shows advisory issue, unknown, and pass explanations in every human review adapter without changing JSON or SARIF execution policy", () => {
    const review: ReviewReport = {
      repo: "/local/project", startedAt: scan.startedAt, completedAt: scan.completedAt,
      durationMs: scan.durationMs, semgrepFindings: 0, summary, findings: [],
      reviewChecks: [
        { id: "tenant", name: "Tenant isolation", status: "issue", reason: "The query omits tenant isolation.", fix: "Bind tenant ID in the query." },
        { id: "auth", name: "Authorization", status: "unknown", reason: "Deployment authentication configuration is unavailable.", fix: "" },
        { id: "parsing", name: "Literal input", status: "pass", reason: "The inspected input path preserves literal data.", fix: "" },
      ],
    };
    const document = createReviewReportDocument(review);
    for (const format of ["terminal", "markdown", "html"] as const) {
      const output = formatPresentationDocument(document, format);
      for (const check of review.reviewChecks!) {
        expect(output).toContain(check.name);
        expect(output).toContain(check.status.toUpperCase());
        expect(output).toContain(check.reason.replace(/\./g, format === "markdown" ? "\\." : "."));
        if (check.fix) expect(output).toContain(check.fix.replace(/\./g, format === "markdown" ? "\\." : "."));
      }
      expect(output).not.toContain("passed all tests");
    }
    expect(JSON.parse(formatPresentationDocument(document, "json"))).toEqual(review);
    const sarif = JSON.parse(formatPresentationDocument(document, "sarif"));
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(sarif.runs[0].results.map((result: { kind: string }) => result.kind)).toEqual(["fail", "open", "pass"]);
    expect(sarif.runs[0].results.map((result: { properties: { reviewCheck: unknown } }) => result.properties.reviewCheck)).toEqual(review.reviewChecks);
  });

  it("renders failed research visibly in finding-free human and SARIF reports", () => {
    const review: ReviewReport = {
      repo: "/local/project", startedAt: scan.startedAt, completedAt: scan.completedAt,
      durationMs: scan.durationMs, semgrepFindings: 0, summary, findings: [],
      researchFailed: true, warnings: [{ stage: "review-checks", message: "Configured check output is incomplete." }],
    };
    const document = createReviewReportDocument(review);
    for (const format of ["terminal", "markdown", "html"] as const) {
      const output = formatPresentationDocument(document, format);
      expect(output).toContain("Configured check output is incomplete.");
      expect(output).not.toContain("passed all tests");
    }
    const sarif = JSON.parse(formatPresentationDocument(document, "sarif"));
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(false);
  });
});
