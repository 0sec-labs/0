/**
 * The report of a scan: the findings a thread stored, in a versioned shape.
 *
 * A scan is a thread that follows the `scan` skill (docs/design/scan-as-a-thread.md). Findings
 * are stored under the thread's id by the `finding` tool, whoever in the thread recorded them
 * (the thread itself or a helper agent), so the report reads the store and never the transcript.
 */
import { createHash } from "node:crypto";
import type { Finding, ScanReport } from "@0/engine/shared";

export const SCAN_REPORT_SCHEMA_VERSION = 1;

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type ScanSeverity = typeof SEVERITIES[number];
const rank = (severity: string): number => { const index = (SEVERITIES as readonly string[]).indexOf(severity); return index < 0 ? SEVERITIES.length : index; };

export interface ScanOutcome {
  /** A label that is the same on every machine: a git URL without credentials, or the folder's name. Never an absolute path. */
  target: string;
  /** Where the scanned code was on this machine (the folder, and its real path); finding paths are made relative to it. */
  roots?: readonly string[];
  threadId: string;
  startedAt: string;
  completedAt: string;
  budgetUsd: number;
  costUsd?: number;
  /** The thread stopped at its cost ceiling; the findings are partial. */
  budgetExhausted: boolean;
  /** The scan hit --timeout and was cancelled; the findings are partial. */
  timedOut?: boolean;
  /** The thread failed or its answer was not backed by its checks. */
  failed: boolean;
  error?: string;
  /** The thread's closing summary: coverage and what was not reached. */
  summary?: string;
  /** Set when more than one pass ran: how many were asked for, finished with a report, and could not finish. */
  passes?: { requested: number; completed: number; failed: number };
  /** Every pass's thread, first to last. */
  threadIds?: readonly string[];
}

/** A path inside the scanned folder, relative to it with forward slashes; undefined when it points outside. */
export function repoRelativePath(path: string, roots: readonly string[] = []): string | undefined {
  let value = path.trim().replace(/\\/g, "/");
  for (const root of roots) {
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (base && (value === base || value.startsWith(`${base}/`))) { value = value.slice(base.length).replace(/^\/+/, ""); break; }
  }
  value = value.replace(/^(\.\/)+/, "");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.split("/").includes("..")) return undefined;
  return value;
}

/** Where a finding is, as a key that does not depend on the model's wording or on the machine: the same place in unchanged code. */
export function locationKey(relativePath: string, startLine: number): string {
  return createHash("sha256").update(`${relativePath}:${startLine}`).digest("hex").slice(0, 24);
}

/**
 * The stored finding with its path relative to the scanned folder, the category as its rule id (the tool stores
 * "manual"), and a location-based fingerprint. The stored fingerprint hashes the title and the evidence text, which the
 * model words differently on every run, and the SARIF key would also carry the absolute checkout path.
 */
function reportFinding(finding: Finding, roots: readonly string[]): Finding {
  const annotation = finding.reviewAnnotation;
  const path = annotation ? repoRelativePath(annotation.path, roots) : undefined;
  const located = annotation && path ? { ...annotation, path } : undefined;
  return {
    ...finding,
    templateId: finding.templateId === "manual" ? finding.category : finding.templateId,
    ...(located ? { reviewAnnotation: located, fingerprint: `loc:${locationKey(located.path, located.startLine)}` } : { reviewAnnotation: undefined }),
  };
}

/** A finding that more than one pass found, merged: how many of the passes did. */
export type MergedFinding = Finding & { foundInPasses?: number };

/** Cited lines of one file that overlap or lie within this many lines of each other are one flaw. */
const MERGE_LINE_GAP = 3;

interface Cluster { path: string | undefined; title: string; start: number; end: number; passes: Set<number>; best: Finding }

const weight = (finding: Finding): number => (SEVERITIES.length - rank(finding.severity)) * 1_000_000 + finding.description.length + finding.evidence.request.length + finding.evidence.response.length + (finding.evidence.analysis?.length ?? 0);

/**
 * The findings of several passes over the same code as one list. Two findings are one flaw when they cite the same file at
 * overlapping or nearby lines (or, with no location, have the same title), and a pass never merges with itself, so two
 * different flaws close together in one pass stay two. The merged finding is the most severe, most detailed version and
 * records how many passes found it. A flaw only some passes find is a useful signal, and the union is the point.
 */
export function mergePasses(passes: readonly (readonly Finding[])[], roots: readonly string[] = []): MergedFinding[] {
  const clusters: Cluster[] = [];
  passes.forEach((findings, pass) => {
    for (const raw of findings) {
      const finding = reportFinding(raw, roots);
      const location = finding.reviewAnnotation;
      const start = location?.startLine ?? 0;
      const end = location?.endLine ?? start;
      const title = finding.title.trim().toLowerCase();
      const match = clusters.find(cluster => !cluster.passes.has(pass) && (location && cluster.path
        ? cluster.path === location.path && start <= cluster.end + MERGE_LINE_GAP && cluster.start <= end + MERGE_LINE_GAP
        : !location && !cluster.path && cluster.title === title));
      if (match) {
        match.passes.add(pass);
        match.start = Math.min(match.start, start);
        match.end = Math.max(match.end, end);
        if (weight(finding) > weight(match.best)) match.best = finding;
      } else clusters.push({ path: location?.path, title, start, end, passes: new Set([pass]), best: finding });
    }
  });
  return clusters.map(cluster => (passes.length > 1 ? { ...cluster.best, foundInPasses: cluster.passes.size } : cluster.best));
}

const count = (findings: readonly Finding[], severity: ScanSeverity) => findings.filter(finding => finding.severity === severity).length;
const byRank = (findings: readonly Finding[]): Finding[] => [...findings].sort((a, b) => rank(a.severity) - rank(b.severity) || a.title.localeCompare(b.title));

/** The shared report type the exporter understands (md, sarif, html, pdf), with this scan's facts on top of the stored rows. */
export function toScanReport(outcome: ScanOutcome, stored: ScanReport): ScanReport {
  const total = outcome.passes?.requested ?? 1;
  const findings = byRank(stored.findings.map(finding => {
    const shaped = reportFinding(finding, outcome.roots ?? []);
    const found = (finding as MergedFinding).foundInPasses;
    // The exporters have no field for it, so say it where every format shows it.
    return total > 1 && found ? { ...shaped, description: `${shaped.description}\n\nFound in ${found} of ${total} scan passes.` } : shaped;
  }));
  return {
    ...stored,
    // A remote-style label makes the exporters write repo-relative paths (a folder label is read as a checkout location).
    target: /^[A-Za-z][A-Za-z0-9+.-]*:|^git@/.test(outcome.target) ? outcome.target : `source:${outcome.target}`,
    startedAt: outcome.startedAt,
    completedAt: outcome.completedAt,
    durationMs: Math.max(0, Date.parse(outcome.completedAt) - Date.parse(outcome.startedAt)),
    findings,
    summary: { totalAttacks: 0, totalFindings: findings.length, critical: count(findings, "critical"), high: count(findings, "high"), medium: count(findings, "medium"), low: count(findings, "low"), info: count(findings, "info") },
    // The stored rows carry a note that the export was rebuilt from a legacy record; a scan is not one.
    warnings: [...(outcome.passes && outcome.passes.failed > 0 ? [{ stage: "report" as const, message: `${outcome.passes.failed} of ${outcome.passes.requested} scan passes could not finish; the findings may be incomplete.` }] : [])].concat(outcome.budgetExhausted ? [{ stage: "report" as const, message: `Stopped at the $${outcome.budgetUsd} budget; findings are partial.` }] : outcome.timedOut ? [{ stage: "report" as const, message: "Stopped at the time limit; findings are partial." }] : []),
    executionSuccessful: !outcome.failed,
    ...(outcome.costUsd !== undefined ? { estimatedCostUsd: outcome.costUsd } : {}),
    ...(outcome.budgetExhausted ? { costCeilingExceeded: true, exitReason: "cost_ceiling_exceeded" as const } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

/** The documented JSON contract of `0 scan --format json`. Field names are stable within a schemaVersion. */
export function scanJson(outcome: ScanOutcome, stored: readonly Finding[]): Record<string, unknown> {
  const findings = byRank(stored.map(finding => reportFinding(finding, outcome.roots ?? [])));
  return {
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    target: outcome.target,
    threadId: outcome.threadId,
    startedAt: outcome.startedAt,
    completedAt: outcome.completedAt,
    budgetUsd: outcome.budgetUsd,
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    ...(outcome.threadIds && outcome.threadIds.length > 1 ? { threadIds: outcome.threadIds } : {}),
    ...(outcome.passes && outcome.passes.requested > 1 ? { passes: outcome.passes } : {}),
    status: outcome.failed ? "failed" : outcome.budgetExhausted ? "budget_exhausted" : outcome.timedOut ? "timed_out" : "complete",
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.summary ? { summary: outcome.summary } : {}),
    counts: { total: findings.length, critical: count(findings, "critical"), high: count(findings, "high"), medium: count(findings, "medium"), low: count(findings, "low"), info: count(findings, "info") },
    findings: findings.map(finding => ({
      id: finding.id,
      // A hash of the file and first cited line, so a flaw in the same place of unchanged code keeps it from scan to scan
      // (it does not depend on how the model worded the finding). Absent when the finding cites no location.
      ...(finding.fingerprint?.startsWith("loc:") ? { fingerprint: finding.fingerprint.slice(4) } : {}),
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      status: finding.status,
      // With several passes: how many of them found this flaw. A flaw only one pass found is real but less certain.
      ...((finding as MergedFinding).foundInPasses !== undefined ? { foundInPasses: (finding as MergedFinding).foundInPasses } : {}),
      description: finding.description || finding.evidence.analysis || "",
      ...(finding.reviewAnnotation ? { location: { path: finding.reviewAnnotation.path, startLine: finding.reviewAnnotation.startLine, ...(finding.reviewAnnotation.endLine !== undefined ? { endLine: finding.reviewAnnotation.endLine } : {}) } } : {}),
      evidence: finding.evidence,
      ...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
      ...(finding.cvssScore !== undefined ? { cvssScore: finding.cvssScore } : {}),
      ...(finding.cvssVector ? { cvssVector: finding.cvssVector } : {}),
      ...(finding.impactAssessment ? { impact: finding.impactAssessment } : {}),
      ...(finding.reviewAnnotation?.suggestion ? { suggestedFix: { replacement: finding.reviewAnnotation.suggestion } } : {}),
    })),
  };
}

/** Exit code: 1 for a failed scan or a finding at or above the threshold, 3 for a budget or time stop, else 0. */
export function scanExitCode(outcome: ScanOutcome, findings: readonly Finding[], failOn: ScanSeverity | undefined): number {
  if (outcome.failed) return 1;
  if (failOn && findings.some(finding => rank(finding.severity) <= rank(failOn))) return 1;
  return outcome.budgetExhausted || outcome.timedOut ? 3 : 0;
}
