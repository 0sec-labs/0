import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { osecDB } from "@0/engine/storage";
import type { Finding } from "@0/engine/shared";
import { importCiReport, prepareCiReportImport } from "./report-import.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function destination() { const directory = mkdtempSync(join(tmpdir(), "0-ci-import-")); directories.push(directory); return join(directory, "engine.db"); }
function finding(): Finding {
  return { id: "source-finding", templateId: "xss", title: "Unescaped response", description: "A source claim.",
    severity: "high", category: "xss", status: "confirmed", evidence: { request: "GET /", response: "200", analysis: "Source report analysis" },
    timestamp: 1735689600000, fingerprint: "native-family", triageStatus: "accepted", workflowStatus: "done",
    reviewAnnotation: { path: "src/app.ts", startLine: 1 }, verificationSpec: { command: "touch SHOULD_NEVER_RUN" } as unknown as Finding["verificationSpec"],
    verification_result: { status: "reproduced" } as Finding["verification_result"], pocSteps: [{ action: "shell" }] as unknown as Finding["pocSteps"] };
}
function report(extra: Record<string, unknown> = {}) {
  return { target: "repo:/runner/source", scanDepth: "quick", startedAt: "2025-01-01T00:00:00.000Z", completedAt: "2025-01-01T00:01:00.000Z",
    durationMs: 60000, summary: { totalFindings: 999, high: 999 }, findings: [finding()], warnings: [], executionSuccessful: true, ...extra };
}
function metadata(extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, repository: "example/source", githubEventRevision: "event-sha", reviewedRevision: "checkout-sha", cliExitCode: 0, target: ".", ...extra };
}
function input(extra: Record<string, unknown> = {}) { return { reportJson: JSON.stringify(report(extra)), metadataJson: JSON.stringify(metadata()), dbPath: destination() }; }

describe("CI report import", () => {
  it("retains an immutable source snapshot with namespaced passive findings and original timestamps", () => {
    const options = input();
    const result = importCiReport(options);
    const db = new osecDB(options.dbPath);
    try {
      const scan = db.getScan(result.scanId)!;
      expect(scan).toMatchObject({ mode: "ci-import", runtime: "external-ci", status: "completed", startedAt: report().startedAt, completedAt: report().completedAt, durationMs: 60000 });
      const summary = JSON.parse(scan.summary!);
      expect(summary.totalFindings).toBe(1); expect(summary.high).toBe(1);
      expect(summary.originalReport).toEqual(report());
      expect(summary.ciImport).toMatchObject({ schemaVersion: 1, source: "ci", trust: "unverified", sourceExecutionStatus: "successful", metadata: metadata() });
      expect(summary.ciImport.reportSha256).toMatch(/^[a-f0-9]{64}$/);
      const saved = db.getFindings(result.scanId)[0]!;
      expect(saved).toMatchObject({ status: "discovered", triageStatus: "new", workflowStatus: "backlog", timestamp: finding().timestamp });
      expect(saved.id).not.toBe(finding().id); expect(saved.fingerprint).toMatch(new RegExp(`^${result.scanId}:`));
      expect(saved.evidenceAnalysis).toContain("not independently verified");
      expect(db.getFindingReviewFields(saved.id)).toEqual({});
      expect(saved.verificationSpec).toBeNull(); expect(saved.pocSteps).toBeNull();
      expect(db.getEvents(result.scanId, { eventType: "ci_report_imported" })).toHaveLength(1);
    } finally { db.close(); }
  });

  it("deduplicates equivalent JSON without changing source provenance or triage on reimport", () => {
    const options = input(); const first = importCiReport(options);
    const db = new osecDB(options.dbPath);
    let originalSummary: string;
    try { originalSummary = db.getScan(first.scanId)!.summary!; } finally { db.close(); }
    const second = importCiReport({ ...options, reportJson: JSON.stringify(Object.fromEntries(Object.entries(report()).reverse()), null, 2) });
    expect(second).toMatchObject({ scanId: first.scanId, alreadyImported: true });
    const reopened = new osecDB(options.dbPath);
    try { expect(reopened.getScan(first.scanId)!.summary).toBe(originalSummary!); expect(reopened.listScans()).toHaveLength(1); expect(reopened.getFindings(first.scanId)).toHaveLength(1); }
    finally { reopened.close(); }
  });

  it("keeps different CI attempts and native finding families separate", () => {
    const options = input(); const db = new osecDB(options.dbPath);
    try { db.createScan({ target: report().target, depth: "quick", format: "json" }, "native-scan"); db.saveFinding("native-scan", finding()); } finally { db.close(); }
    const first = importCiReport(options);
    const second = importCiReport({ ...options, metadataJson: JSON.stringify(metadata({ runAttempt: "2" })) });
    expect(second.scanId).not.toBe(first.scanId);
    const reopened = new osecDB(options.dbPath);
    try { expect(reopened.getFinding(finding().id)?.status).toBe("confirmed"); expect(reopened.getRelatedFindings(finding().fingerprint!)).toHaveLength(1); expect(reopened.getFindings(first.scanId)[0]!.triageStatus).toBe("new"); }
    finally { reopened.close(); }
  });

  it.each([
    { executionSuccessful: false }, { error: "stage failed" }, { costCeilingExceeded: true }, { exitReason: "partial" },
    { exitReason: "cost_ceiling_exceeded" }, { attempts: [{ status: "failed" }] }, { plannedRuns: 2, completedRuns: 1 }, { completedAt: "" },
  ])("retains failed/incomplete reports without presenting a successful run: %j", extra => {
    const options = input(extra); const result = importCiReport(options); const db = new osecDB(options.dbPath);
    try { const scan = db.getScan(result.scanId)!; expect(scan.status).toBe("failed"); expect(JSON.parse(scan.summary!).ciImport.sourceExecutionStatus).toBe("failed"); expect(db.getFindings(result.scanId)).toHaveLength(1); }
    finally { db.close(); }
  });

  it("distinguishes unknown older execution evidence and cancellation", () => {
    const unknown = prepareCiReportImport(JSON.stringify(report({ executionSuccessful: undefined })));
    expect(unknown.status).toBe("failed"); expect(unknown.provenance.sourceExecutionStatus).toBe("unknown");
    expect(prepareCiReportImport(JSON.stringify(report({ exitReason: "cancelled" }))).status).toBe("cancelled");
  });

  it("a nonzero CI process exit outranks the report's success claim", () => {
    const prepared = prepareCiReportImport(JSON.stringify(report()), JSON.stringify(metadata({ cliExitCode: 4 })));
    expect(prepared.status).toBe("failed"); expect(prepared.provenance.sourceExecutionStatus).toBe("failed");
  });

  it.each([
    { target: "" }, { startedAt: "not-a-date" }, { durationMs: -1 }, { scanDepth: "unknown" },
    { findings: [{ ...finding(), severity: "fatal" }] }, { findings: [finding(), finding()] },
    { findings: [{ ...finding(), timestamp: 1e100 }] }, { findings: [{ ...finding(), evidence: { request: [], response: "" } }] },
    { warnings: [{ stage: "review", message: {} }] }, { executionSuccessful: "yes" },
  ])("rejects malformed reports before creating a destination database: %j", extra => {
    const options = input(extra); expect(() => importCiReport(options)).toThrow(); expect(existsSync(options.dbPath)).toBe(false);
  });

  it("rejects invalid metadata and absent destination before storage", () => {
    const options = input();
    expect(() => importCiReport({ ...options, dbPath: "" })).toThrow("explicit destination");
    expect(() => importCiReport({ ...options, metadataJson: JSON.stringify(metadata({ schemaVersion: 2 })) })).toThrow("schemaVersion");
    expect(() => importCiReport({ ...options, metadataJson: JSON.stringify(metadata({ cliExitCode: -1 })) })).toThrow("cliExitCode");
    expect(existsSync(options.dbPath)).toBe(false);
  });

  it("rejects nonfinite JSON numbers even in unknown source fields", () => {
    const options = input();
    expect(() => importCiReport({ ...options, reportJson: JSON.stringify(report()).replace('"durationMs":60000', '"extra":1e999,"durationMs":60000') })).toThrow("nonfinite");
    expect(() => importCiReport({ ...options, metadataJson: JSON.stringify(metadata()).replace('"schemaVersion":1', '"extra":1e999,"schemaVersion":1') })).toThrow("nonfinite");
    expect(existsSync(options.dbPath)).toBe(false);
  });

  it("does not reset native case status, latest scan, or work artifacts for the same target", () => {
    const options = input(); const db = new osecDB(options.dbPath);
    let before: unknown;
    try {
      db.createScan({ target: report().target, depth: "quick", format: "json" }, "native-scan");
      const nativeCase = db.listCases()[0]!;
      db.upsertCase({ ...nativeCase, targetType: "repository", status: "done" }); before = db.listCases();
    } finally { db.close(); }
    importCiReport(options);
    const reopened = new osecDB(options.dbPath);
    try { expect(reopened.listCases()).toEqual(before); expect(reopened.listArtifacts()).toHaveLength(0); }
    finally { reopened.close(); }
  });

  it("bounds report size, nesting, and finding count", () => {
    expect(() => prepareCiReportImport(" ".repeat(20 * 1024 * 1024 + 1))).toThrow("size limit");
    let nested: unknown = {}; for (let index = 0; index < 70; index++) nested = { nested };
    expect(() => prepareCiReportImport(JSON.stringify(report({ nested })))).toThrow("nesting");
    expect(() => prepareCiReportImport(JSON.stringify(report({ findings: Array.from({ length: 2001 }, finding) })))).toThrow("at most");
  });

  it("refuses native scan and finding identity collisions without replacing native records", () => {
    const prepared = prepareCiReportImport(JSON.stringify(report())); const path = destination(); const db = new osecDB(path);
    try {
      db.createScan({ target: "native", depth: "quick", format: "json" }, prepared.scanId);
      expect(() => db.importCiReport(prepared)).toThrow("collides"); expect(db.getScan(prepared.scanId)!.target).toBe("native");
      db.deleteScan(prepared.scanId);
      db.createScan({ target: "native", depth: "quick", format: "json" }, "native");
      db.saveFinding("native", { ...finding(), id: prepared.findings[0]!.id });
      expect(() => db.importCiReport(prepared)).toThrow("collides"); expect(db.getScan(prepared.scanId)).toBeUndefined(); expect(db.getFinding(prepared.findings[0]!.id)?.scanId).toBe("native");
    } finally { db.close(); }
  });

  it("rolls back the scan, findings, and provenance if event persistence fails", () => {
    const prepared = prepareCiReportImport(JSON.stringify(report())); const db = new osecDB(destination());
    try {
      vi.spyOn(db, "logEvent").mockImplementation(() => { throw new Error("storage interrupted"); });
      expect(() => db.importCiReport(prepared)).toThrow("storage interrupted");
      expect(db.getScan(prepared.scanId)).toBeUndefined(); expect(db.getFinding(prepared.findings[0]!.id)).toBeUndefined(); expect(db.listCases()).toHaveLength(0);
    } finally { db.close(); }
  });
});
