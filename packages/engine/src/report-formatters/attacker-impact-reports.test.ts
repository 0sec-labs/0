import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "../shared/index.js";
import { formatHtml } from "./html.js";
import { formatMarkdown } from "./markdown.js";
import { formatSarif } from "./sarif.js";

const impact = { reachability_tier: "remote-unauth", blast_radius: "An unauthenticated caller can run any shell command as the service account.", weaponizability: "rce", business_impact: "unassessed", rationale: "exec() takes req.body.host unchecked" } as const;
function finding(id: string, severity: Finding["severity"], assessment?: Finding["impactAssessment"]): Finding {
  return { id, templateId: id, title: id, description: "Observed evidence", severity, category: "command-injection", status: "confirmed", evidence: { request: "request", response: "response" }, timestamp: 1, ...(assessment ? { impactAssessment: assessment } : {}) } as Finding;
}
function report(): ScanReport {
  return { target: "https://example.test", scanDepth: "default", startedAt: "2026-10-02T00:00:00Z", completedAt: "2026-10-02T00:01:00Z", durationMs: 60_000, warnings: [],
    summary: { totalAttacks: 0, totalFindings: 3, critical: 1, high: 1, medium: 0, low: 1, info: 0 },
    findings: [finding("LowOne", "low"), finding("CriticalAssessed", "critical", impact), finding("HighPlain", "high")] } as ScanReport;
}

describe("reports say what an attacker can do, and rank by severity", () => {
  it.each([["Markdown", formatMarkdown], ["HTML", formatHtml]] as const)("%s lists the most severe first and shows the attacker's view only where it was assessed", (_name, format) => {
    const output = format(report());
    expect(output.indexOf("CriticalAssessed")).toBeLessThan(output.indexOf("HighPlain"));
    expect(output.indexOf("HighPlain")).toBeLessThan(output.indexOf("LowOne"));
    expect(output).toContain("An unauthenticated caller can run any shell command");
    expect(output).toContain("run their own code");
    expect(output).not.toMatch(/Business priority|Business impact|Not assessed/);
  });
  it("SARIF carries the sentence in the alert message, keeps technical levels, and has no business priority", () => {
    const results = JSON.parse(formatSarif(report())).runs[0].results;
    expect(results.map((item: { properties: { findingId: string } }) => item.properties.findingId)).toEqual(["CriticalAssessed", "HighPlain", "LowOne"]);
    expect(results[0].message.text).toContain("What an attacker can do: An unauthenticated caller");
    expect(results[1].message.text).not.toContain("What an attacker can do");
    expect(results[0].level).toBe("error");
    expect(JSON.stringify(results)).not.toMatch(/businessPriority/);
  });
});
