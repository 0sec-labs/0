import { createHash } from "node:crypto";
import { osecDB } from "@0/engine/storage";
import type { Finding, ScanReport } from "@0/engine/shared";

const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_FINDINGS = 2000;
const severities = ["critical", "high", "medium", "low", "info"] as const;
type CiImportProvenance = {
  schemaVersion: 1;
  source: "ci";
  trust: "unverified";
  sourceExecutionStatus: "successful" | "failed" | "unknown";
  digest: string;
  reportSha256: string;
  metadataSha256: string | null;
  importedAt: string;
  metadata: Record<string, unknown> | null;
};
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 1024 * 1024, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${label}.`);
  return value;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64, false);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label}.`);
  return result;
}
function parseJson(value: string, label: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds the size limit.`);
  try { return object(JSON.parse(value), label); }
  catch { throw new Error(`${label} must be a JSON object.`); }
}
/** Stable JSON identities ignore whitespace/key order, while retaining array order. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("Report JSON nesting exceeds the limit.");
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Report JSON contains a nonfinite number.");
  return JSON.stringify(value);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function prepareCiReportImport(reportJson: string, metadataJson?: string): Parameters<osecDB["importCiReport"]>[0] {
  const original = parseJson(reportJson, "Report", MAX_REPORT_BYTES);
  const target = text(original.target, "report target", 8192, false);
  if (!["quick", "default", "deep"].includes(String(original.scanDepth))) throw new Error("Invalid report scanDepth.");
  const startedAt = timestamp(original.startedAt, "report startedAt");
  const completedAt = original.completedAt === "" || original.completedAt === null ? "" : timestamp(original.completedAt, "report completedAt");
  if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) throw new Error("Report completedAt precedes startedAt.");
  const durationMs = finite(original.durationMs, "report durationMs");
  if (!Array.isArray(original.findings) || original.findings.length > MAX_FINDINGS) throw new Error(`Report must contain at most ${MAX_FINDINGS} findings.`);
  if (original.warnings !== undefined && !Array.isArray(original.warnings)) throw new Error("Invalid report warnings.");
  for (const warning of (original.warnings ?? []) as unknown[]) {
    const entry = object(warning, "report warning");
    text(entry.stage, "warning stage", 512); text(entry.message, "warning message");
  }
  const metadata = metadataJson === undefined ? null : parseJson(metadataJson, "CI metadata", MAX_METADATA_BYTES);
  if (metadata) {
    if (metadata.schemaVersion !== 1) throw new Error("Unsupported CI metadata schemaVersion.");
    if (!Number.isInteger(metadata.cliExitCode) || Number(metadata.cliExitCode) < 0 || Number(metadata.cliExitCode) > 255) throw new Error("Invalid CI metadata cliExitCode.");
    for (const key of ["repository", "githubEventRevision", "reviewedRevision", "cliVersion", "ref", "runId", "runAttempt", "mode", "target", "runtime", "depth", "diffBase"]) {
      if (metadata[key] !== undefined && metadata[key] !== null) text(metadata[key], `CI metadata ${key}`, 8192);
    }
    if (metadata.costCeilingUsd !== undefined) finite(metadata.costCeilingUsd, "CI metadata costCeilingUsd");
  }
  if (original.executionSuccessful !== undefined && typeof original.executionSuccessful !== "boolean") throw new Error("Invalid report executionSuccessful.");
  if (original.costCeilingExceeded !== undefined && typeof original.costCeilingExceeded !== "boolean") throw new Error("Invalid report costCeilingExceeded.");
  if (original.exitReason !== undefined && !["completed", "cost_ceiling_exceeded", "time_cap_exceeded", "cancelled", "failed", "partial"].includes(String(original.exitReason))) throw new Error("Invalid report exitReason.");
  if (original.error !== undefined) text(original.error, "report error");
  if (original.plannedRuns !== undefined) finite(original.plannedRuns, "report plannedRuns");
  if (original.completedRuns !== undefined) finite(original.completedRuns, "report completedRuns");
  if (original.attempts !== undefined && (!Array.isArray(original.attempts) || original.attempts.some(attempt => !attempt || typeof attempt !== "object" || !["completed", "failed", "rejected", "cancelled", "time_cap_exceeded", "cost_ceiling_exceeded"].includes(String((attempt as Record<string, unknown>).status))))) throw new Error("Invalid report attempts.");
  const reportSha256 = hash(canonical(original));
  const metadataSha256 = metadata ? hash(canonical(metadata)) : null;
  const digest = hash(`${reportSha256}\n${metadataSha256 ?? ""}`);
  const scanId = `ci-${digest}`;
  const findings: Finding[] = [];
  const sourceIds = new Set<string>();
  for (const value of original.findings) {
    const finding = object(value, "finding");
    const sourceId = text(finding.id, "finding id", 512, false);
    if (sourceIds.has(sourceId)) throw new Error("Duplicate finding id in report.");
    sourceIds.add(sourceId);
    if (!severities.includes(finding.severity as typeof severities[number])) throw new Error("Invalid finding severity.");
    const evidence = object(finding.evidence, "finding evidence");
    const findingTimestamp = finite(finding.timestamp, "finding timestamp");
    if (!Number.isFinite(new Date(findingTimestamp).getTime())) throw new Error("Invalid finding timestamp.");
    findings.push({
      id: `${scanId}-${hash(sourceId)}`, fingerprint: `${scanId}:${hash(sourceId)}`,
      templateId: text(finding.templateId, "finding templateId", 512, false),
      title: text(finding.title, "finding title", 4096, false),
      description: text(finding.description, "finding description"),
      category: text(finding.category, "finding category", 128, false) as Finding["category"],
      severity: finding.severity as Finding["severity"],
      evidence: { request: text(evidence.request, "evidence request"), response: text(evidence.response, "evidence response"),
        analysis: `Imported CI evidence; not independently verified by this engine.${evidence.analysis === undefined ? "" : `\n\n${text(evidence.analysis, "evidence analysis")}`}` },
      timestamp: findingTimestamp, status: "discovered", triageStatus: "new", workflowStatus: "backlog",
    });
  }
  const failed = original.executionSuccessful === false || Boolean(original.error) || original.costCeilingExceeded === true ||
    (Boolean(original.exitReason) && original.exitReason !== "completed") || !completedAt ||
    (Array.isArray(original.attempts) && original.attempts.some(attempt => (attempt as Record<string, unknown>).status !== "completed")) ||
    (typeof original.plannedRuns === "number" && typeof original.completedRuns === "number" && original.completedRuns < original.plannedRuns) ||
    (metadata !== null && metadata.cliExitCode !== 0);
  const successful = !failed && original.executionSuccessful === true;
  const status = original.exitReason === "cancelled" ? "cancelled" as const : successful ? "completed" as const : "failed" as const;
  const provenance: CiImportProvenance = { schemaVersion: 1, source: "ci", trust: "unverified", sourceExecutionStatus: failed ? "failed" : successful ? "successful" : "unknown", digest, reportSha256, metadataSha256, importedAt: new Date().toISOString(), metadata };
  return { scanId, report: original as unknown as ScanReport, findings, status, provenance,
    summary: { totalAttacks: 0, totalFindings: findings.length, ...Object.fromEntries(severities.map(severity => [severity, findings.filter(finding => finding.severity === severity).length])),
      executionSuccessful: successful, exitReason: successful ? "completed" : status === "cancelled" ? "cancelled" : "partial" } };
}

/** Explicit local snapshot import; never executes report content or contacts CI. */
export function importCiReport(options: { reportJson: string; metadataJson?: string; dbPath: string }): { scanId: string; alreadyImported: boolean; dbPath: string } {
  if (typeof options.dbPath !== "string" || !options.dbPath.trim()) throw new Error("An explicit destination database path is required.");
  const input = prepareCiReportImport(options.reportJson, options.metadataJson);
  const db = new osecDB(options.dbPath);
  try { return { ...db.importCiReport(input), dbPath: db.databasePath }; }
  finally { db.close(); }
}
