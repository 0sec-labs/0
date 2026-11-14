// Access-control probe diffing and small text helpers.
// Extracted verbatim from ../tools.ts; the public API is re-exported there.
import { readFileSync } from "node:fs";
import { compareRoles } from "@0/shared";
import { hasKnownMarkerText } from "../../disclose/known-marker.js";

// ── Access-control probe helpers (0#564) ──

/** A principal the access-control probe can issue requests as. */
export interface ProbePrincipal {
  label: string;
  role?: string;
  /** Outbound auth + cookie headers for this principal. */
  headers: () => Record<string, string>;
  /** Capture session state (Set-Cookie / re-auth) from a response. */
  capture: (res: Response) => void;
}

/** A single response captured by the probe. */
export interface ProbeResponse {
  identity: string;
  role?: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
  body: string;
  /** Set when the response body exceeds the 10k capture ceiling. */
  truncated?: boolean;
  redacted?: boolean;
}

/** Normalize a response body for similarity comparison. */
export function normalizeBody(s: string): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Token-Jaccard similarity of two response bodies in [0, 1]. 1 = identical
 * (after whitespace/case normalization), 0 = no shared tokens. Deterministic;
 * used to decide whether a comparison identity retrieved the SAME resource as
 * the authorized baseline (the signature of broken object-level authorization).
 */
export function bodySimilarity(a: string, b: string): number {
  const na = normalizeBody(a);
  const nb = normalizeBody(b);
  if (na === "" && nb === "") return 1;
  if (na === nb) return 1;
  const ta = new Set(na.split(" ").filter(Boolean));
  const tb = new Set(nb.split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

export interface AccessDiffResult {
  broken: boolean;
  verdict: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  bodySimilarity: number;
  statusMatch: boolean;
  note: string;
}

export const is2xx = (s: number): boolean => s >= 200 && s < 300;

/**
 * Diff an authorized baseline response against a comparison identity's
 * response and decide whether an authorization boundary was broken.
 *
 * Logic:
 *  - comparison 401/403 → `properly_denied` (the control works).
 *  - baseline not 2xx → `inconclusive` (no authorized resource to leak).
 *  - comparison 2xx + a declared restricted owner marker in both successful
 *    responses + expectDenied → confirmed owner-resource disclosure.
 *  - body similarity or role difference without that proof → unverified lead.
 *  - comparison 2xx + different body otherwise → `accessible_distinct_resource`
 *    (likely its own data; flagged for manual review, not a confirmed break).
 */
export function diffAccessResponses(
  baseline: Pick<ProbeResponse, "status" | "body">,
  comparison: Pick<ProbeResponse, "status" | "body">,
  opts: { baselineRole?: string; comparisonRole?: string; expectDenied?: boolean; ownershipMarker?: string },
): AccessDiffResult {
  const sim = bodySimilarity(baseline.body, comparison.body);
  const statusMatch = baseline.status === comparison.status;
  const vertical = compareRoles(opts.comparisonRole, opts.baselineRole) < 0;

  if (!is2xx(baseline.status)) {
    return {
      broken: false,
      verdict: "inconclusive",
      severity: "info",
      bodySimilarity: sim,
      statusMatch,
      note: `baseline identity did not return an authorized 2xx (HTTP ${baseline.status}); cannot establish a protected resource to leak`,
    };
  }

  if (comparison.status === 401 || comparison.status === 403) {
    return {
      broken: false,
      verdict: "properly_denied",
      severity: "info",
      bodySimilarity: sim,
      statusMatch,
      note: `comparison identity was correctly denied (HTTP ${comparison.status})`,
    };
  }

  if (is2xx(comparison.status)) {
    const marker = opts.ownershipMarker;
    if (opts.expectDenied && marker && baseline.body.includes(marker) && comparison.body.includes(marker)) {
      return {
        broken: true,
        verdict: vertical ? "vertical_privilege_escalation" : "broken_object_level_authorization",
        severity: "high", bodySimilarity: sim, statusMatch,
        note: "comparison identity retrieved the declared restricted owner marker from the authorized resource",
      };
    }
    return {
      broken: false,
      verdict: opts.expectDenied || vertical || sim >= 0.9 ? "unverified_access_candidate" : "accessible_distinct_resource",
      severity: "info", bodySimilarity: sim, statusMatch,
      note: "HTTP success or body similarity alone does not establish restricted ownership; provide expect_denied and a known private ownership_marker, or verify a workflow postcondition",
    };
  }

  return {
    broken: false,
    verdict: "inconclusive",
    severity: "info",
    bodySimilarity: sim,
    statusMatch,
    note: `comparison HTTP ${comparison.status} is neither a clear allow (2xx) nor deny (401/403)`,
  };
}

/** Truncated, non-secret evidence snapshot of a probe response. */
export function probeEvidence(resp: ProbeResponse): Record<string, unknown> {
  return {
    identity: resp.identity,
    role: resp.role,
    request: { url: resp.url, method: resp.method },
    response: {
      status: resp.status,
      contentType: resp.contentType,
      bodyLength: resp.body.length,
      bodyPreview: resp.body.slice(0, 1_000),
    },
  };
}

// #674 Part E — only an exact, workspace-contained citation can establish
// maintainer awareness. The vocabulary is shared with disclosure-draft warnings.
export function citedSourceHasKnownMarker(
  absolutePath: string,
  startLine: number,
  endLine: number,
): boolean {
  try {
    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
    const cited = lines.slice(startLine - 1, endLine).join("\n");
    return hasKnownMarkerText(cited);
  } catch {
    // The source annotation remains valid even when a concurrent edit makes
    // this best-effort read fail; never invent maintainer awareness.
    return false;
  }
}

/** Cap a string to `max` chars, appending a truncation marker when clipped. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
}

/** Keep the last ~2KB of a traceback (the exception line + nearest frames). */
export function tracebackTail(trace: string): string {
  const t = trace.trimEnd();
  return t.length <= 2_000 ? t : "..." + t.slice(-2_000);
}
