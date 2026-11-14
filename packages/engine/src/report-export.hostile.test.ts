import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "./shared/index.js";
import { exportReport } from "./report-export.js";

// Deterministic xorshift so failures reproduce.
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }
const pieces = ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "\"><svg onload=alert(1)>", "'-alert(1)-'", "javascript:alert(1)", "[x](javascript:alert(1))", "](http://evil)", "\n# injected heading\n", "```\n", "| a | b |\n", "\u0000", "\ud800", "\udfff", "‮", "\r\n", "&amp;", "${x}", "{{7*7}}", "<!--", "-->", "]]>", "日本語", "🦊", "\\", "`"];
function hostile(rand: () => number, big = false): string {
  let out = "";
  const n = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) out += pieces[Math.floor(rand() * pieces.length)];
  return big ? out.repeat(20_000) : out;
}
function makeReport(rand: () => number, big = false): ScanReport {
  const finding = (i: number): Finding => ({
    id: `F-${i}-${hostile(rand)}`, templateId: hostile(rand), title: hostile(rand, big && i === 0), description: hostile(rand), severity: (["critical", "high", "medium", "low", "info"] as const)[i % 5]!,
    category: "xss" as Finding["category"], status: "verified", timestamp: 1_800_000_000_000,
    evidence: { request: hostile(rand), response: hostile(rand), analysis: hostile(rand) },
  });
  return {
    target: hostile(rand), scanDepth: "quick", startedAt: "2026-11-08T04:25:12.178Z", completedAt: "2026-11-08T04:25:28.495Z", durationMs: 1,
    warnings: [{ stage: hostile(rand), message: hostile(rand) }],
    summary: { totalAttacks: 1, totalFindings: 5, critical: 1, high: 1, medium: 1, low: 1, info: 1 },
    findings: [0, 1, 2, 3, 4].map(finding),
  };
}
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("hostile report content", () => {
  it.each(["json", "markdown", "html", "sarif"] as const)("exports %s for 40 random hostile reports without throwing", async format => {
    const rand = rng(1234);
    for (let i = 0; i < 40; i++) {
      const out = await exportReport(makeReport(rand), format);
      const text = decode(out.body);
      if (format === "json" || format === "sarif") expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  it("never emits attacker-controlled markup in HTML", async () => {
    const rand = rng(99);
    for (let i = 0; i < 40; i++) {
      const html = decode((await exportReport(makeReport(rand), "html")).body);
      expect(html).not.toContain("<img src=x onerror");
      expect(html).toContain("&lt;");
      expect(html).not.toContain("\"><svg onload");
      expect(html).not.toMatch(/<script>alert\(1\)/);
      expect(html).not.toMatch(/href="javascript:/i);
    }
  });

  it("handles multi-megabyte titles", async () => {
    const report = makeReport(rng(5), true);
    for (const format of ["json", "markdown", "html", "sarif"] as const) {
      expect((await exportReport(report, format)).body.byteLength).toBeGreaterThan(1_000_000);
    }
  });

  it("renders a PDF for hostile content", async () => {
    const out = await exportReport(makeReport(rng(7)), "pdf");
    expect(decode(out.body.subarray(0, 5))).toBe("%PDF-");
  });

  it("tolerates findings that only carry required fields", async () => {
    const report = makeReport(rng(8));
    const minimal = report.findings.map(f => ({ id: f.id, templateId: f.templateId, title: f.title, description: f.description, severity: f.severity, category: f.category, status: f.status, evidence: { request: "", response: "" }, timestamp: f.timestamp })) as Finding[];
    for (const format of ["markdown", "html", "sarif"] as const) await exportReport({ ...report, findings: minimal }, format);
  });
});
