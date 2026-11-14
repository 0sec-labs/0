import type { FindingGroup, ScanRecord } from "@/types";
import { BOARD_ORDER, STATUS_LABEL, findingStatus, isClosedStatus, type FindingStatus } from "@/components/findings/findings-model";
import { SEVERITY_ORDER, normalizeSeverity, type SeverityLevel } from "@/console/panel/views/findings-model";
import { fixStage, type PanelFix } from "@/console/panel/views/fixes-model";

/** Status new findings start in; the engine reports it for any finding nobody has triaged. */
export const DEFAULT_FINDING_STATE: FindingStatus = "backlog";
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type FindingStateRow = { status: FindingStatus; label: string; kind: "Open" | "Closed"; isDefault: boolean; count: number };

/** One row per fixed finding status, in lifecycle order, counted over the same groups the Findings page lists. */
export function findingStateRows(groups: readonly FindingGroup[]): FindingStateRow[] {
  const counts = new Map<FindingStatus, number>();
  for (const group of groups) { const status = findingStatus(group); counts.set(status, (counts.get(status) ?? 0) + 1); }
  return BOARD_ORDER.map(status => ({ status, label: STATUS_LABEL[status], kind: isClosedStatus(status) ? "Closed" : "Open", isDefault: status === DEFAULT_FINDING_STATE, count: counts.get(status) ?? 0 }));
}

export const countLabel = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const COMPLETED_SCAN = new Set(["completed", "complete", "done"]);
const time = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : undefined; };

export type ActivityInput = {
  scans: readonly ScanRecord[];
  groups: readonly FindingGroup[];
  /** Chats on this engine with their creation time and message count. */
  sessions: readonly { createdAt: string; messageCount?: number }[];
  fixes: readonly PanelFix[];
  now: number;
};
export type ActivityStats = {
  missions: number;
  scansCompleted: number;
  findingsFound: number;
  findingsBySeverity: Record<SeverityLevel, number>;
  fixesProposed: number;
  fixesApplied: number;
  pullRequests: number;
  /** True when nothing happened in the window, so the page can say so instead of showing zeros as results. */
  empty: boolean;
};

/** Counts over the last seven days, from records that carry their own timestamps. Blank chats do not count as missions. */
export function activityStats({ scans, groups, sessions, fixes, now }: ActivityInput): ActivityStats {
  const since = now - WEEK_MS;
  const within = (stamp: number | undefined) => stamp !== undefined && stamp >= since && stamp <= now + 60_000;
  const findingsBySeverity = Object.fromEntries(SEVERITY_ORDER.map(level => [level, 0])) as Record<SeverityLevel, number>;
  let findingsFound = 0;
  for (const group of groups) {
    if (!within(group.latest.timestamp)) continue;
    findingsFound += 1;
    findingsBySeverity[normalizeSeverity(group.latest.severity)] += 1;
  }
  const recentFixes = fixes.filter(entry => within(time(entry.updatedAt)));
  const stats = {
    missions: sessions.filter(session => session.messageCount !== 0 && within(time(session.createdAt))).length,
    scansCompleted: scans.filter(scan => COMPLETED_SCAN.has(scan.status.toLowerCase()) && within(time(scan.completedAt))).length,
    findingsFound,
    findingsBySeverity,
    fixesProposed: recentFixes.filter(entry => ["proposed", "retested", "applied", "pr-opened"].includes(fixStage(entry.fix))).length,
    fixesApplied: recentFixes.filter(entry => ["applied", "pr-opened"].includes(fixStage(entry.fix)) && (entry.fix.applied || entry.fix.application?.applied)).length,
    pullRequests: recentFixes.filter(entry => Boolean(entry.fix.published?.prUrl)).length,
  };
  return { ...stats, empty: stats.missions + stats.scansCompleted + stats.findingsFound + stats.fixesProposed + stats.pullRequests === 0 };
}

export type PullRequestRow = { id: string; url: string; title: string; branch: string; baseBranch?: string; findingTitle: string; updatedAt: string };

/** Fixes whose pull request was opened by this engine, newest first. Merge state is not tracked. */
export function pullRequestRows(fixes: readonly PanelFix[]): PullRequestRow[] {
  return fixes
    .filter(entry => Boolean(entry.fix.published?.prUrl))
    .map(({ fix, updatedAt }) => ({ id: fix.id, url: fix.published!.prUrl, title: fix.publication?.title || fix.finding.title, branch: fix.published!.branch, baseBranch: fix.publication?.baseBranch, findingTitle: fix.finding.title, updatedAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The pull request link is only rendered for web URLs. */
export const safePullRequestUrl = (url: string): string | undefined => { try { const parsed = new URL(url); return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined; } catch { return undefined; } };
