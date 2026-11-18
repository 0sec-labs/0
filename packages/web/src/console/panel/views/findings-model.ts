import type { FindingGroup } from "../../../types";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
export type SeverityLevel = (typeof SEVERITY_ORDER)[number];
export const SEVERITY_LABELS: Record<SeverityLevel, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

/** Unknown severities fall to `info` so a row is never dropped. */
export function normalizeSeverity(value: string): SeverityLevel {
  const key = value.trim().toLowerCase();
  if (key === "informational") return "info";
  return (SEVERITY_ORDER as readonly string[]).includes(key) ? key as SeverityLevel : "info";
}

export type FindingStatusFilter = "all" | "open" | "verified" | "accepted" | "fixed";
export type FindingFilters = { status: FindingStatusFilter; severity: SeverityLevel | "all" };
export const DEFAULT_FINDING_FILTERS: FindingFilters = { status: "all", severity: "all" };

const FIXED = new Set(["fixed", "resolved", "remediated", "patched"]);
const CLOSED = new Set([...FIXED, "false_positive", "false-positive", "dismissed", "wont_fix", "closed"]);
const statusKey = (value: string) => value.trim().toLowerCase();

export function isFixedFinding(group: FindingGroup): boolean {
  return FIXED.has(statusKey(group.latest.status));
}
export const isVerifiedFinding = (group: FindingGroup) => group.workflow?.consensus === "verified" || statusKey(group.latest.status) === "verified" || statusKey(group.latest.status) === "confirmed";
export const isOpenFinding = (group: FindingGroup) => !CLOSED.has(statusKey(group.latest.status)) && group.workflow?.consensus !== "false-positive";

/** Accepted risk: a person accepted it, but the finding stays open until it is fixed or dismissed. */
export const isAcceptedFinding = (group: FindingGroup) =>
  group.latest.triageStatus === "accepted" && isOpenFinding(group) && group.workflow?.status !== "done" && group.workflow?.status !== "cancelled";

/** The status text a finding row shows; accepted risk wins over the workflow status while the finding is open. */
export const findingStatusLabel = (group: FindingGroup) => isAcceptedFinding(group) ? "Accepted" : statusLabel(group.workflow?.status ?? group.latest.status);

export function matchesFilters(group: FindingGroup, filters: FindingFilters): boolean {
  if (filters.severity !== "all" && normalizeSeverity(group.latest.severity) !== filters.severity) return false;
  switch (filters.status) {
    case "open": return isOpenFinding(group);
    case "verified": return isVerifiedFinding(group);
    case "accepted": return isAcceptedFinding(group);
    case "fixed": return isFixedFinding(group);
    default: return true;
  }
}

export type SeverityGroup = { severity: SeverityLevel; label: string; findings: FindingGroup[] };

/** Groups findings by severity (critical first), newest first within a group; empty groups are omitted. */
export function groupBySeverity(groups: readonly FindingGroup[], filters: FindingFilters = DEFAULT_FINDING_FILTERS): SeverityGroup[] {
  const buckets = new Map<SeverityLevel, FindingGroup[]>();
  for (const group of groups) {
    if (!matchesFilters(group, filters)) continue;
    const level = normalizeSeverity(group.latest.severity);
    buckets.set(level, [...buckets.get(level) ?? [], group]);
  }
  return SEVERITY_ORDER.flatMap(severity => {
    const findings = buckets.get(severity);
    return findings ? [{ severity, label: SEVERITY_LABELS[severity], findings: [...findings].sort((a, b) => b.latest.timestamp - a.latest.timestamp) }] : [];
  });
}

export function severityCounts(groups: readonly FindingGroup[]): Record<SeverityLevel, number> {
  const counts: Record<SeverityLevel, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const group of groups) counts[normalizeSeverity(group.latest.severity)] += 1;
  return counts;
}

/** The independent-agent verdict is "Corroborated"; "Verified" is reserved for a check the harness ran. */
export const consensusLabel = (value: string) => value === "verified" ? "Corroborated" : statusLabel(value);

export function statusLabel(value: string): string {
  const text = value.replaceAll("_", " ").replaceAll("-", " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Unknown";
}
