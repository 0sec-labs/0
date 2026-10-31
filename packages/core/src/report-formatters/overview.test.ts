import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@0/shared";
import { renderOverview } from "./overview.js";

describe("report overview", () => {
  it("preserves ungrouped findings and links every finding once", () => {
    const findings = ["a", "b", "c"].map(id => ({ id, title: id, description: "Context", severity: "high", evidence: { request: "", response: "" } }) as Finding);
    const report = { overview: { summary: "<script>unsafe</script>", groups: [{ title: "Isolation", summary: "A theme", nextStep: "Validate", findingIds: ["a", "a", "missing"] }, { title: "Execution", summary: "Another theme", nextStep: "Verify", findingIds: ["a", "b"] }] } } as unknown as ScanReport;
    const html = renderOverview(report, findings);
    expect(html.match(/data-open-finding=/g)).toHaveLength(3);
    expect(html).toContain("Other findings");
    expect(html).toContain('href="#finding-3"');
    expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(html).not.toContain("<script>unsafe");
  });
});
