import type { Finding } from "@0/shared";
import { parseImpactAssessment, type NativeRuntime } from "@0/core";
import type { getRuntimeAvailability } from "../utils.js";
import { fitTuiText, fitTuiUrl } from "./text.js";
import { restoreFindingReviewFields } from "@0/db";


export interface OpsSnapshot {
  scans: Array<{ id: string; target: string; status: string; mode: string; depth: string; runtime: string; durationMs?: number | null; summary?: string | null }>;
  findings: Array<{ id: string; title: string; severity: string; category: string; scanId: string }>;
  incidents: Array<{ scanId: string; target: string; stage: string; headline: string }>;
}

export interface HistoryScanRow {
  id: string;
  target: string;
  status: string;
  mode: string;
  depth: string;
  runtime: string;
  startedAt: string;
  durationMs?: number | null;
  summary?: string | null;
}

export interface FindingsRow {
  id: string;
  scanId: string;
  title: string;
  severity: string;
  category: string;
  status: string;
  fingerprint?: string | null;
  triageStatus?: string | null;
  triageNote?: string | null;
  timestamp: number;
  score?: number | null;
  templateId: string;
  description: string;
  evidenceRequest: string;
  evidenceResponse: string;
  evidenceAnalysis?: string | null;
  /** Persisted JSON assessment; unavailable or invalid values are never inferred. */
  impactAssessment?: string | null;
  /**
   * JSON-stringified VerificationSpec as stored by `@0/db`. NULL for
   * findings that carry no machine-executable re-check contract. The
   * source-fix action parses it back before asking `fixEligibility`.
   */
  verificationSpec?: string | null;
  verificationResult?: string | null;
  sourceVerification?: string | null;
  reviewAnnotation?: string | null;
}

export interface FindingsScreenOptions {
  dbPath?: string;
  scan?: string;
  severity?: string;
  category?: string;
  status?: string;
  triage?: string;
  limit: number;
  all?: boolean;
}

export interface FindingGroup {
  fingerprint: string;
  latest: FindingsRow;
  count: number;
  scans: number;
}

export interface DoctorState {
  nodeOk: boolean;
  nodeVersion: string;
  hasApiKey: boolean;
  availableRuntimes: string[];
  apiRuntime: Awaited<ReturnType<typeof getRuntimeAvailability>>["apiRuntime"];
}

export interface ReplayScanRow {
  id: string;
  target: string;
  status: string;
  mode: string;
  depth: string;
  runtime: string;
  durationMs?: number | null;
  summary?: string | null;
  startedAt: string;
}

export interface ReplayEventRow {
  id: string;
  stage: string;
  eventType: string;
  payload: string;
  timestamp: number;
}


export function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function parseSummary(summary?: string | null): { totalFindings?: number } {
  if (!summary) return {};
  try {
    return JSON.parse(summary) as { totalFindings?: number };
  } catch {
    return {};
  }
}

export function groupFindings(rows: FindingsRow[]): FindingGroup[] {
  const groups = new Map<string, FindingsRow[]>();
  for (const row of rows) {
    const key = row.fingerprint ?? row.id;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .map(([fingerprint, items]) => {
      const sorted = items.sort((a, b) => b.timestamp - a.timestamp);
      return {
        fingerprint,
        latest: sorted[0],
        count: sorted.length,
        scans: new Set(sorted.map((item) => item.scanId)).size,
      };
    })
    .sort((a, b) => b.latest.timestamp - a.latest.timestamp);
}


function parseJsonColumn(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Malformed persisted JSON is unavailable, never a partial stand-in.
    return undefined;
  }
}

/**
 * Rebuild a finding using the canonical impact parser and the database's
 * conservative review/source-check hydrator. Unusable persisted fields stay absent.
 */
export function findingFromRow(row: FindingsRow): Finding {
  const impactAssessment = parseJsonColumn(row.impactAssessment) === undefined
    ? undefined
    : parseImpactAssessment(row.impactAssessment!) ?? undefined;
  const record: Record<string, unknown> = {
    id: row.id,
    templateId: row.templateId,
    title: row.title,
    description: row.description,
    severity: row.severity,
    category: row.category,
    status: row.status,
    fingerprint: row.fingerprint ?? undefined,
    triageStatus: row.triageStatus ?? undefined,
    timestamp: row.timestamp,
    evidence: {
      request: row.evidenceRequest,
      response: row.evidenceResponse,
      analysis: row.evidenceAnalysis ?? undefined,
    },
    verificationSpec: parseJsonColumn(row.verificationSpec),
    impactAssessment,
    ...restoreFindingReviewFields(row),
  };
  return record as unknown as Finding;
}

export function isNativeRuntime(runtime: unknown): runtime is NativeRuntime {
  return typeof (runtime as Partial<NativeRuntime>)?.executeNative === "function";
}


export function cycleChoice<T extends string>(items: readonly T[], current: T, delta: 1 | -1): T {
  const index = items.indexOf(current);
  const next = index < 0 ? 0 : (index + delta + items.length) % items.length;
  return items[next];
}

export function describeEventPayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (typeof parsed.summary === "string") return fitTuiText(parsed.summary, 120);
    if (typeof parsed.message === "string") return fitTuiText(parsed.message, 120);
    if (typeof parsed.error === "string") return fitTuiText(parsed.error, 120);
    if (typeof parsed.action === "string") return fitTuiText(parsed.action, 120);
    if (typeof parsed.target === "string") return fitTuiUrl(parsed.target, 120);
  } catch {
    // fall through
  }
  return fitTuiText(payload, 120);
}

export function describeFindingsFilters(options: FindingsScreenOptions): string {
  const filters = [
    options.scan ? `scan:${options.scan}` : null,
    options.severity ? `severity:${options.severity}` : null,
    options.category ? `category:${options.category}` : null,
    options.status ? `status:${options.status}` : null,
    options.triage ? `triage:${options.triage}` : null,
  ].filter(Boolean);
  return filters.length > 0 ? filters.join(" · ") : "all findings";
}
