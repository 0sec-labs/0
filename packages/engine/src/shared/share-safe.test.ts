import { describe, expect, it } from "vitest";
import { ShareSafeReportSchema, shareSafeTarget, toShareSafeReport } from "./share-safe.js";
import type { ScanReport } from "./types.js";

function report(overrides: Record<string, unknown> = {}): ScanReport {
  const finding = {
    id: "f1",
    templateId: "sqli",
    title: "SQL injection in /login",
    description: "Payload ' OR 1=1 -- returned the admin token sk-live-SECRET",
    severity: "high",
    category: "sql-injection",
    status: "confirmed",
    fingerprint: "fp-1",
    triageNote: "contact bob@example.com",
    confidence: 0.9,
    cvssScore: 8.1,
    evidence: { request: "POST /login Authorization: Bearer SECRET", response: "token=SECRET" },
    pocSteps: [{ command: "curl -H 'Cookie: SECRET'" }],
    futureSecretField: "must never leave the machine",
    reviewAnnotation: { path: "src/auth.ts", startLine: 10, endLine: 12, suggestion: "replace with SECRET" },
    ...overrides,
  };
  return {
    target: "https://user:pass@staging.example.com/app?token=SECRET#frag",
    scanDepth: "quick",
    startedAt: "2026-11-14T00:00:00.000Z",
    completedAt: "2026-11-14T00:00:01.000Z",
    durationMs: 1000,
    summary: { totalAttacks: 3, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    findings: [finding],
    warnings: [],
  } as unknown as ScanReport;
}

describe("toShareSafeReport", () => {
  it("keeps only allowlisted fields and never leaks secrets", () => {
    const out = toShareSafeReport(report());
    const text = JSON.stringify(out);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("bob@example.com");
    expect(text).not.toContain("futureSecretField");
    expect(text).not.toContain("pass");
    expect(out.schemaVersion).toBe(1);
    expect(out.kind).toBe("0.share-safe-report");
    expect(out.findings[0]).toMatchObject({ id: "f1", severity: "high", fingerprint: "fp-1", location: { path: "src/auth.ts", startLine: 10, endLine: 12 } });
    expect(out.findings[0]).not.toHaveProperty("description");
    expect(ShareSafeReportSchema.safeParse(out).success).toBe(true);
  });

  it("includes descriptions only when asked", () => {
    const out = toShareSafeReport(report(), { includeDescription: true });
    expect(out.findings[0]?.description).toContain("admin token");
    expect(out.redactions).not.toContain("description");
    expect(toShareSafeReport(report()).redactions).toContain("description");
  });

  it("drops absolute and escaping locations", () => {
    for (const path of ["/Users/me/app/src/a.ts", "C:\\work\\a.ts", "../outside.ts", "~/a.ts"]) {
      const out = toShareSafeReport(report({ reviewAnnotation: { path, startLine: 1 } }));
      expect(out.findings[0]).not.toHaveProperty("location");
    }
  });

  it("is deterministic JSON-serialisable output", () => {
    const a = JSON.stringify(toShareSafeReport(report()));
    expect(a).toBe(JSON.stringify(toShareSafeReport(report())));
  });
});

describe("shareSafeTarget", () => {
  it("strips credentials, query and fragment from URLs", () => {
    expect(shareSafeTarget("https://u:p@host.example.com/a/b?x=1#y")).toBe("https://host.example.com/a/b");
    expect(shareSafeTarget("https://host.example.com/")).toBe("https://host.example.com");
  });
  it("collapses filesystem paths to the last segment", () => {
    expect(shareSafeTarget("/Users/me/code/my-app")).toBe("my-app");
    expect(shareSafeTarget("C:\\work\\my-app")).toBe("my-app");
    expect(shareSafeTarget("./")).toBe("local-target");
  });
  it("keeps plain names", () => {
    expect(shareSafeTarget("lodash@4.17.21")).toBe("lodash@4.17.21");
  });
});
