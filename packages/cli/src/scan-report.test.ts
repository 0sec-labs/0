import type { Finding, ScanReport } from "@0/engine/shared";
import { describe, expect, it } from "vitest";
import { exportReport } from "@0/engine";
import { locationKey, repoRelativePath, scanExitCode, scanJson, toScanReport, type ScanOutcome } from "./scan-report.js";

const stored = (overrides: Partial<Finding> = {}): Finding => ({
  id: "f1", templateId: "manual", title: "SQL injection in /users", description: "", severity: "high", category: "sql-injection", status: "discovered", timestamp: 1,
  fingerprint: "abc123", confidence: 0.9, cvssScore: 8.1, cvssVector: "CVSS:3.1/AV:N",
  evidence: { request: "GET /users?id=1'", response: "500", analysis: "id reaches the query" },
  reviewAnnotation: { path: "src/users.ts", startLine: 12, endLine: 14, suggestion: "db.query('select 1 where id = ?', [id])" },
  ...overrides,
}) as Finding;

const outcome: ScanOutcome = { target: "repo", threadId: "t1", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z", budgetUsd: 5, costUsd: 0.4, budgetExhausted: false, failed: false, summary: "covered src/" };
const base = (findings: Finding[]): ScanReport => ({ target: "", scanDepth: "default", startedAt: "", completedAt: "", durationMs: 0, summary: { totalAttacks: 0, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings, warnings: [{ stage: "report", message: "Export reconstructed from retained scan rows." }] });

describe("scanJson", () => {
  it("is versioned and carries counts, location, evidence, fingerprint and the fix", () => {
    const report = scanJson(outcome, [stored()]) as Record<string, any>;
    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("complete");
    expect(report.counts).toEqual({ total: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 });
    expect(report.findings[0]).toMatchObject({ id: "f1", fingerprint: locationKey("src/users.ts", 12), title: "SQL injection in /users", severity: "high", category: "sql-injection", location: { path: "src/users.ts", startLine: 12, endLine: 14 }, cvssScore: 8.1, suggestedFix: { replacement: "db.query('select 1 where id = ?', [id])" } });
  });
  it("falls back to the analysis when a finding has no description", () => {
    expect((scanJson(outcome, [stored()]) as Record<string, any>).findings[0].description).toBe("id reaches the query");
  });
  it("lists the worst findings first", () => {
    const report = scanJson(outcome, [stored({ id: "low", title: "a", severity: "low" }), stored({ id: "crit", title: "b", severity: "critical" })]) as Record<string, any>;
    expect(report.findings.map((finding: { id: string }) => finding.id)).toEqual(["crit", "low"]);
  });
  it("marks a partial scan and a failed scan", () => {
    expect((scanJson({ ...outcome, budgetExhausted: true }, []) as Record<string, any>).status).toBe("budget_exhausted");
    expect((scanJson({ ...outcome, failed: true, error: "boom" }, []) as Record<string, any>)).toMatchObject({ status: "failed", error: "boom" });
  });
  it("has no findings and a complete status for a clean scan", () => {
    expect(scanJson(outcome, [])).toMatchObject({ status: "complete", counts: { total: 0 }, findings: [] });
  });
});

describe("toScanReport", () => {
  it("puts this scan's target, times and counts over the stored rows and drops the legacy note", () => {
    const report = toScanReport(outcome, base([stored(), stored({ id: "f2", severity: "critical" })]));
    expect(report).toMatchObject({ target: "source:repo", durationMs: 60_000, summary: { totalFindings: 2, critical: 1, high: 1 }, warnings: [] });
    expect(report.findings[0]!.severity).toBe("critical");
  });
  it("warns that a budget stop is partial", () => {
    const report = toScanReport({ ...outcome, budgetExhausted: true }, base([]));
    expect(report.warnings[0]!.message).toMatch(/partial/);
    expect(report.costCeilingExceeded).toBe(true);
  });
});

describe("scanExitCode", () => {
  const findings = [stored()];
  it("is 0 without a threshold", () => expect(scanExitCode(outcome, findings, undefined)).toBe(0));
  it("is 1 when a finding reaches the threshold", () => expect(scanExitCode(outcome, findings, "high")).toBe(1));
  it("is 0 when findings are below the threshold", () => expect(scanExitCode(outcome, findings, "critical")).toBe(0));
  it("is 1 for a failed scan", () => expect(scanExitCode({ ...outcome, failed: true }, [], undefined)).toBe(1));
  it("is 3 when the budget ran out and nothing else fired", () => expect(scanExitCode({ ...outcome, budgetExhausted: true }, [], "high")).toBe(3));
});

describe("a report that reads the same in CI", () => {
  const ci = { ...outcome, target: "repo", roots: ["/home/runner/work/repo/repo", "/private/home/runner/work/repo/repo"] };
  const at = (path: string, overrides: Partial<Finding> = {}) => stored({ templateId: "manual", fingerprint: "text-hash-that-changes", reviewAnnotation: { path, startLine: 12, endLine: 14 }, ...overrides });

  it("repoRelativePath strips the checkout root and rejects anything outside it", () => {
    expect(repoRelativePath("/home/runner/work/repo/repo/src/a.ts", ci.roots)).toBe("src/a.ts");
    expect(repoRelativePath("/private/home/runner/work/repo/repo/src/a.ts", ci.roots)).toBe("src/a.ts");
    expect(repoRelativePath("./src/a.ts", ci.roots)).toBe("src/a.ts");
    expect(repoRelativePath("src\\a.ts", ci.roots)).toBe("src/a.ts");
    for (const bad of ["/etc/passwd", "../x.ts", "src/../../x.ts", "C:/x.ts", "https://x/y", ""]) expect(repoRelativePath(bad, ci.roots), bad).toBeUndefined();
  });

  it("locationKey depends on the place and not on anything else", () => {
    expect(locationKey("src/a.ts", 12)).toBe(locationKey("src/a.ts", 12));
    expect(locationKey("src/a.ts", 12)).not.toBe(locationKey("src/a.ts", 13));
    expect(locationKey("src/a.ts", 12)).not.toBe(locationKey("src/b.ts", 12));
  });

  it("gives the same JSON fingerprint and a relative path on two machines and two runs, whatever the model wrote", () => {
    const one = scanJson({ ...ci, roots: ["/home/runner/work/repo/repo"] }, [at("/home/runner/work/repo/repo/src/a.ts", { title: "SQL injection in the user lookup" })]) as Record<string, any>;
    const two = scanJson({ ...ci, roots: ["/Users/dev/code/repo"] }, [at("/Users/dev/code/repo/src/a.ts", { title: "User id reaches a query unescaped", evidence: { request: "other words", response: "x" } })]) as Record<string, any>;
    expect(one.findings[0].location.path).toBe("src/a.ts");
    expect(one.findings[0].fingerprint).toBe(two.findings[0].fingerprint);
    expect(one.target).toBe("repo");
  });

  it("omits the fingerprint when a finding cites no usable location", () => {
    const report = scanJson(ci, [at("/etc/passwd")]) as Record<string, any>;
    expect(report.findings[0].fingerprint).toBeUndefined();
    expect(report.findings[0].location).toBeUndefined();
  });

  it("SARIF has repo-relative paths, the category as rule id and a key that does not move", async () => {
    const sarifFor = async (root: string, title: string) => {
      const report = toScanReport({ ...ci, roots: [root] }, base([at(`${root}/src/a.ts`, { title, category: "sql-injection" as Finding["category"] })]));
      const artifact = await exportReport(report, "sarif", "x");
      return JSON.parse(new TextDecoder().decode(artifact.body)).runs[0];
    };
    const a = await sarifFor("/home/runner/work/repo/repo", "First wording");
    const b = await sarifFor("/Users/dev/other-checkout/repo", "A completely different wording");
    const result = a.results[0];
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe("src/a.ts");
    expect(result.locations[0].physicalLocation.region).toMatchObject({ startLine: 12, endLine: 14 });
    expect(result.ruleId).toBe("sql-injection");
    expect(result.partialFingerprints.primary).toMatch(/^loc:[0-9a-f]{24}$/);
    expect(result.partialFingerprints.primary).toBe(b.results[0].partialFingerprints.primary);
    expect(JSON.stringify(a)).not.toMatch(/\/home\/runner|\/Users\/dev/);
  });
});
