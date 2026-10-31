import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@0/shared";
import { findingPresentation, targetLabel } from "./presentation.js";
import { formatHtml } from "./html.js";

describe("reader-facing report copy", () => {
  it("replaces local review directories with a project name", () => {
    expect(targetLabel("/Users/peak/.0/reviews/agent37-20261030T012540Z/source")).toBe("Agent37");
    expect(targetLabel("https://example.test/private/path")).toBe("example.test");
    expect(targetLabel("/work/my-project")).toBe("My-project");
  });
  it("uses edited copy while preserving escaped technical evidence on demand", () => {
    const finding = { id: "f1", title: "Long internal title", description: "Technical context <script>alert(1)</script>", severity: "high", category: "missing-validation", status: "discovered", evidence: { request: "private request", response: "full response", analysis: "" }, presentation: { title: "A clear title", summary: "A clear consequence.", action: "Check ownership." } } as Finding;
    const report = { target: "/Users/peak/.0/reviews/agent37-20261030T012540Z/source", findings: [finding], summary: { high: 1, critical: 0, medium: 0, low: 0, info: 0, totalFindings: 1, totalAttacks: 1 }, warnings: [], startedAt: "2026-10-30T00:00:00Z", completedAt: "2026-10-30T00:01:00Z", durationMs: 60000, scanDepth: "deep" } as ScanReport;
    const original = JSON.stringify(report);
    const html = formatHtml(report);
    expect(findingPresentation(finding).title).toBe("A clear title");
    expect(html).toContain("Check ownership.");
    expect(html).toContain("private request");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("/Users/peak");
    const payload = html.match(/<script type="application\/json" id="finding-data">([\s\S]*?)<\/script>/)![1]!;
    expect(JSON.parse(payload)).toEqual([finding]);
    expect(html.slice(0, html.indexOf('<script type="application/json"'))).not.toContain("missing-validation");
    expect(html).not.toContain("blast radius");
    expect(JSON.stringify(report)).toBe(original);
  });
});
