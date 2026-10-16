import { describe, expect, it } from "vitest";
import type { ScanReport } from "@0/shared";
import { exportReport, isReportExportFormat } from "./report-export.js";

const report: ScanReport = {
  target: "<script>repository</script>", scanDepth: "deep", startedAt: "2026-10-02T10:00:00Z", completedAt: "2026-10-02T10:01:00Z", durationMs: 60000,
  executionSuccessful: false, warnings: [{ stage: "report", message: "Run stopped before completion" }],
  summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  findings: [{ id: "finding-1", templateId: "source", title: "Unsafe file access", description: "File access escapes root", severity: "high", category: "path-traversal", status: "confirmed", timestamp: 1800000000000, evidence: { request: "source.ts:4", response: "root:x:0:0", analysis: "Reproduced" } }],
};
const decode = (body: Uint8Array) => new TextDecoder().decode(body);
describe("report export", () => {
  it("preserves complete report evidence and unsuccessful execution in JSON and SARIF", async () => {
    const json = await exportReport(report, "json", "../unsafe\r\nfilename");
    expect(JSON.parse(decode(json.body))).toEqual(report);
    expect(json.filename).not.toMatch(/[\/\r\n]/);
    expect(json.contentType).toBe("application/json");
    const sarif = JSON.parse(decode((await exportReport(report, "sarif")).body));
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(false);
    expect(sarif.runs[0].results[0].properties.evidence.response).toBe("root:x:0:0");
  });
  it("renders readable Markdown and escapes report HTML", async () => {
    expect(decode((await exportReport(report, "markdown")).body)).toContain("Unsafe file access");
    const html = decode((await exportReport(report, "html")).body);
    expect(html).toContain("&lt;script&gt;repository&lt;/script&gt;");
    expect(html).not.toContain("<script>repository</script>");
  });
  it("returns a PDF document using the existing renderer", async () => {
    const pdf = await exportReport(report, "pdf");
    expect(decode(pdf.body.subarray(0, 5))).toBe("%PDF-");
    expect(pdf.contentType).toBe("application/pdf");
  });
  it("rejects unsupported formats before invoking a renderer", async () => {
    expect(isReportExportFormat("terminal")).toBe(false);
    await expect(exportReport(report, "exe" as never)).rejects.toThrow("Unsupported");
  });
});
