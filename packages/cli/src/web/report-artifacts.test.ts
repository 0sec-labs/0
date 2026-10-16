import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { osecDB } from "@0/db";
import type { Finding, ScanReport } from "@0/shared";
import { retainedFindingSnapshot, retainedScanSnapshot } from "./report-artifacts.js";

let directory: string;
let path: string;
const finding = (id: string): Finding => ({ id, templateId: "source", title: `Finding ${id}`, description: "Source issue", severity: "high", category: "path-traversal", status: "confirmed", timestamp: 1800000000000,
  evidence: { request: "src/access.ts:4", response: "complete retained evidence", analysis: "Reproduced" },
  reviewAnnotation: { path: "src/access.ts", startLine: 4, endLine: 5, suggestion: "validateRoot(path)" },
  verification_result: { status: "reproduced", mode: "deterministic_replay", finding_id: id, engine_version: "0.23.0", started_at: "2026-10-02T10:00:00Z", completed_at: "2026-10-02T10:01:00Z", duration_ms: 60000, commands: [], assertions: [], evidence_artifacts: [], engine_metadata: { os: "linux", arch: "x64", runner: "local" } },
});
function seed() {
  const db = new osecDB(path);
  try {
    db.createScan({ target: "first-repository", depth: "deep", format: "json" }, "first");
    db.createScan({ target: "second-repository", depth: "quick", format: "json" }, "second");
    db.saveFinding("first", finding("finding-a"));
    db.saveFinding("first", finding("finding-unselected"));
    db.saveFinding("second", finding("finding-b"));
    db.completeScan("first", { totalAttacks: 7 });
  } finally { db.close(); }
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "0-retained-report-test-")); path = join(directory, "findings.db"); seed(); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
describe("retained report artifacts", () => {
  it("retains full evidence and review fields while identifying legacy reconstruction as partial", () => {
    const snapshot = retainedScanSnapshot("first", path);
    const retained = snapshot.findings.find(item => item.id === "finding-a")!;
    expect(retained.evidence).toEqual(finding("finding-a").evidence);
    expect(retained.reviewAnnotation).toEqual(finding("finding-a").reviewAnnotation);
    expect(retained.verification_result).toEqual(finding("finding-a").verification_result);
    expect(snapshot.summary.totalAttacks).toBe(7);
    expect(snapshot.executionSuccessful).toBe(false);
    expect(snapshot.exitReason).toBe("partial");
    expect(snapshot.warnings[0]?.message).toContain("not retained");
    expect(snapshot.reviewChecks).toBeUndefined();
  });
  it("does not invent a completion timestamp for a running retained record", () => {
    const snapshot = retainedScanSnapshot("second", path);
    expect(snapshot.completedAt).toBe("");
    expect(snapshot.durationMs).toBe(0);
    expect(snapshot.executionSuccessful).toBe(false);
    expect(snapshot.exitReason).toBe("partial");
  });
  it("preserves original warnings, review checks, and execution fields exactly", () => {
    const original: ScanReport = { target: "first-repository", scanDepth: "deep", startedAt: "2026-10-02T10:00:00Z", completedAt: "2026-10-02T10:01:00Z", durationMs: 60000,
      summary: { totalAttacks: 9, totalFindings: 99, critical: 0, high: 99, medium: 0, low: 0, info: 0 }, findings: [], warnings: [{ stage: "report", message: "Original warning with context" }], reviewChecks: [{ id: "coverage", name: "Coverage", status: "unknown", reason: "Target unreachable", fix: "Retry" }], executionSuccessful: false, exitReason: "partial" };
    const snapshot = retainedScanSnapshot("first", path, original);
    expect(snapshot.warnings).toEqual(original.warnings);
    expect(snapshot.reviewChecks).toEqual(original.reviewChecks);
    expect(snapshot.startedAt).toBe(original.startedAt);
    expect(snapshot.completedAt).toBe(original.completedAt);
    expect(snapshot.executionSuccessful).toBe(false);
    expect(snapshot.exitReason).toBe("partial");
    expect(snapshot.summary.totalFindings).toBe(2);
    expect(original.summary.totalFindings).toBe(99);
    snapshot.warnings[0]!.message = "mutated export";
    expect(original.warnings[0]!.message).toBe("Original warning with context");
  });
  it("exports every selected finding across runs once and never includes unselected rows", () => {
    const snapshot = retainedFindingSnapshot(["finding-a", "finding-b", "finding-a"], path);
    expect(snapshot.findings.map(item => item.id)).toEqual(["finding-a", "finding-b"]);
    expect(snapshot.summary.totalFindings).toBe(2);
    expect(snapshot.target).toBe("Selected findings from multiple runs");
    expect(snapshot.executionSuccessful).toBe(false);
    expect(snapshot.warnings[0]?.message).toContain("not a complete assessment");
  });
  it("rejects missing or foreign-engine IDs without a partial result or prefix fallback", () => {
    const foreignPath = join(directory, "foreign.db"); const db = new osecDB(foreignPath);
    try { db.createScan({ target: "foreign", depth: "quick", format: "json" }, "foreign"); db.saveFinding("foreign", finding("foreign-finding")); } finally { db.close(); }
    expect(() => retainedFindingSnapshot(["finding-a", "foreign-finding"], path)).toThrow("not found in this engine");
    expect(() => retainedFindingSnapshot(["finding-"], path)).toThrow("not found");
    expect(() => retainedFindingSnapshot([], path)).toThrow("between one and 500");
    expect(() => retainedFindingSnapshot(Array(501).fill("finding-a"), path)).toThrow("between one and 500");
    expect(() => retainedScanSnapshot("foreign", path)).toThrow("Scan not found");
  });
});
