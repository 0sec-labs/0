import { osecDB } from "@0/db";
import type { Finding, ScanReport } from "@0/shared";
import { loadFindingFocus } from "../finding-focus.js";
class ReportArtifactError extends Error { constructor(message: string, readonly statusCode: number) { super(message); } }

function summary(findings: Finding[], totalAttacks = 0): ScanReport["summary"] {
  return { totalAttacks, totalFindings: findings.length, critical: findings.filter(f => f.severity === "critical").length,
    high: findings.filter(f => f.severity === "high").length, medium: findings.filter(f => f.severity === "medium").length,
    low: findings.filter(f => f.severity === "low").length, info: findings.filter(f => f.severity === "info").length };
}
/** Legacy scan rows retain findings but may not retain the complete original report. */
export function retainedScanSnapshot(scanId: string, dbPath?: string, original?: ScanReport): ScanReport {
  const db = new osecDB(dbPath);
  try {
    const scan = db.getScan(scanId);
    if (!scan) throw new ReportArtifactError("Scan not found.", 404);
    const findings = db.getFindings(scanId).map(row => loadFindingFocus(row.id, { dbPath }).finding);
    if (original) return { ...structuredClone(original), findings, summary: { ...original.summary, ...summary(findings, original.summary.totalAttacks) } };
    let retained: Record<string, unknown> = {};
    try { const value = JSON.parse(scan.summary ?? "{}"); if (value && typeof value === "object" && !Array.isArray(value)) retained = value; } catch { /* older summaries are not report documents */ }
    return {
      target: scan.target, scanDepth: ["quick", "default", "deep"].includes(scan.depth) ? scan.depth as ScanReport["scanDepth"] : "default",
      startedAt: scan.startedAt, completedAt: scan.completedAt ?? "", durationMs: scan.durationMs ?? 0,
      findings, summary: summary(findings, typeof retained.totalAttacks === "number" ? retained.totalAttacks : 0),
      warnings: [{ stage: "report", message: "Export reconstructed from retained scan rows. The original report warnings and review checks were not retained in this legacy record." }],
      ...(typeof retained.error === "string" ? { error: retained.error } : {}),
      executionSuccessful: false, exitReason: scan.status === "cancelled" ? "cancelled" as const : "partial" as const,
    };
  } finally { db.close(); }
}
export function retainedFindingSnapshot(ids: string[], dbPath?: string): ScanReport {
  if (!ids.length || ids.length > 500) throw new ReportArtifactError("Select between one and 500 findings to export.", 400);
  const db = new osecDB(dbPath);
  try {
    const findings: Finding[] = [];
    const scanIds = new Set<string>();
    for (const id of new Set(ids)) {
      const row = db.getFinding(id);
      if (!row) throw new ReportArtifactError("A selected finding was not found in this engine.", 404);
      scanIds.add(row.scanId);
      findings.push(loadFindingFocus(id, { dbPath }).finding);
    }
    const scans = [...scanIds].map(id => db.getScan(id)).filter(scan => scan !== undefined);
    return {
      target: scans.length === 1 ? scans[0]!.target : "Selected findings from multiple runs", scanDepth: "default",
      startedAt: scans.map(scan => scan!.startedAt).sort()[0] ?? "", completedAt: scans.map(scan => scan!.completedAt ?? "").sort().at(-1) ?? "",
      durationMs: 0, findings, summary: summary(findings),
      warnings: [{ stage: "report", message: "Selected findings export. This is an evidence collection, not a complete assessment report." }],
      ...(scans.some(scan => scan!.status !== "completed") ? { executionSuccessful: false, exitReason: "partial" as const } : {}),
    };
  } finally { db.close(); }
}
