/**
 * Share-safe projection of a scan report.
 *
 * The projection is an ALLOWLIST: a field leaves the machine only if it is named in
 * these schemas. Zod `.strip()` drops every other key, including fields added to
 * `Finding` or `ScanReport` in the future, so new sensitive fields stay private by
 * default. Never uploaded: evidence requests and responses, PoC steps and output,
 * agent transcripts, triage notes, suggested replacement code, credentials, and
 * local absolute paths. Free-text descriptions are opt-in.
 */
import { z } from "zod";
import type { ScanReport } from "./types.js";

export const SHARE_SAFE_SCHEMA_VERSION = 1;

const short = (max: number) => z.string().max(max);

const ShareSafeLocationSchema = z.object({
  path: short(1024),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().optional(),
}).strip();

const ShareSafeFindingSchema = z.object({
  id: short(256),
  templateId: short(256),
  title: short(300),
  severity: short(32),
  category: short(64),
  status: short(64),
  fingerprint: short(256).optional(),
  triageStatus: short(64).optional(),
  confidence: z.number().min(0).max(1).optional(),
  cvssVector: short(256).optional(),
  cvssScore: z.number().min(0).max(10).optional(),
  location: ShareSafeLocationSchema.optional(),
  description: short(4000).optional(),
}).strip();

const ShareSafeSummarySchema = z.object({
  totalAttacks: z.number().int().nonnegative(),
  totalFindings: z.number().int().nonnegative(),
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
}).strip();

export const ShareSafeReportSchema = z.object({
  schemaVersion: z.literal(SHARE_SAFE_SCHEMA_VERSION),
  kind: z.literal("0.share-safe-report"),
  target: short(512),
  scanDepth: short(32).optional(),
  startedAt: short(64),
  completedAt: short(64),
  durationMs: z.number().int().nonnegative(),
  summary: ShareSafeSummarySchema,
  findings: z.array(ShareSafeFindingSchema),
  redactions: z.array(short(64)),
}).strip();

export type ShareSafeReport = z.infer<typeof ShareSafeReportSchema>;

export interface ShareSafeOptions {
  /** Include each finding's free-text description. Off by default: it can quote code or secrets. */
  includeDescription?: boolean;
}

/** Fields never included. Listed in the output so a reader can see what was withheld. */
const ALWAYS_WITHHELD = [
  "evidence",
  "pocSteps",
  "pocExecution",
  "triageNote",
  "remediation",
  "suggestions",
  "agentTranscripts",
  "credentials",
  "absolutePaths",
] as const;

/** True for paths that identify the local machine or escape the workspace. */
function isLocalOrUnsafePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.split(/[\\/]/).includes("..")
  );
}

/**
 * Reduce a scan target to something safe to share: URLs lose credentials, query and
 * fragment; filesystem paths collapse to their last segment.
 */
export function shareSafeTarget(target: string): string {
  try {
    const url = new URL(target);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
    }
  } catch {
    // Not a URL: fall through to path handling.
  }
  if (isLocalOrUnsafePath(target) || target.includes("\\") || target.includes("/")) {
    const segments = target.split(/[\\/]/).filter((segment) => segment && segment !== "." && segment !== "..");
    return segments.length ? segments[segments.length - 1]! : "local-target";
  }
  return target;
}

type LooseFinding = ScanReport["findings"][number] & {
  reviewAnnotation?: { path?: unknown; startLine?: unknown; endLine?: unknown };
};

function locationOf(finding: LooseFinding) {
  const annotation = finding.reviewAnnotation;
  if (!annotation || typeof annotation.path !== "string" || typeof annotation.startLine !== "number") return undefined;
  if (isLocalOrUnsafePath(annotation.path)) return undefined;
  return {
    path: annotation.path,
    startLine: annotation.startLine,
    ...(typeof annotation.endLine === "number" ? { endLine: annotation.endLine } : {}),
  };
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Project a report onto the share-safe allowlist. Throws if the result fails validation. */
export function toShareSafeReport(report: ScanReport, options: ShareSafeOptions = {}): ShareSafeReport {
  const findings = report.findings.map((finding) => {
    const loose = finding as LooseFinding;
    return dropUndefined({
      id: loose.id,
      templateId: loose.templateId,
      title: loose.title.slice(0, 300),
      severity: loose.severity,
      category: loose.category,
      status: loose.status,
      fingerprint: loose.fingerprint,
      triageStatus: loose.triageStatus,
      confidence: loose.confidence,
      cvssVector: loose.cvssVector,
      cvssScore: loose.cvssScore,
      location: locationOf(loose),
      ...(options.includeDescription ? { description: loose.description.slice(0, 4000) } : {}),
    });
  });
  const withheld: string[] = [...ALWAYS_WITHHELD];
  if (!options.includeDescription) withheld.push("description");
  return ShareSafeReportSchema.parse({
    schemaVersion: SHARE_SAFE_SCHEMA_VERSION,
    kind: "0.share-safe-report",
    target: shareSafeTarget(report.target),
    scanDepth: report.scanDepth,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    durationMs: report.durationMs,
    summary: report.summary,
    findings,
    redactions: withheld,
  });
}
