import type { FindingGroup, FindingWorkflowStatus } from "../../types";
import { missionLabel } from "../../lib/vocabulary";
import { isFixedFinding, normalizeSeverity, SEVERITY_LABELS, SEVERITY_ORDER, type SeverityLevel } from "../../console/panel/views/findings-model";

export { normalizeSeverity, SEVERITY_LABELS, SEVERITY_ORDER, type SeverityLevel };

/* ---------- identity ---------- */

/** Short stable ID derived from the family fingerprint, e.g. `F-3A9C1E`. Never changes while the fingerprint is stable. */
export function findingCode(fingerprint: string): string {
  const clean = fingerprint.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase();
  return `F-${clean || "000000"}`;
}

/* ---------- status ---------- */

export type FindingStatus = FindingWorkflowStatus;

/** Group order: things that need a person first, closed work last. */
export const STATUS_ORDER: readonly FindingStatus[] = ["blocked", "human_review", "agent_review", "in_progress", "todo", "backlog", "done", "cancelled"];
/** Board columns follow the lifecycle left to right. */
export const BOARD_ORDER: readonly FindingStatus[] = ["backlog", "todo", "in_progress", "agent_review", "human_review", "blocked", "done", "cancelled"];
/** Statuses a person can set. Review gates are derived by the engine and are read-only. */
/** The review gate overrides open statuses, so only closing a finding sticks while it needs the operator's review. */
export const REVIEW_LOCK_NOTE = "Needs review: confirm it first. Only Done or Cancelled can be set until then.";
export const statusLockedByReview = (current: FindingStatus, option: FindingStatus) => current === "human_review" && option !== "done" && option !== "cancelled";

export const SETTABLE_STATUSES: readonly FindingStatus[] = ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"];

export const STATUS_LABEL: Record<FindingStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  agent_review: "Agent review",
  in_progress: "In progress",
  human_review: "Needs your review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export const isClosedStatus = (status: FindingStatus) => status === "done" || status === "cancelled";

/**
 * The one status shown for a finding. A dismissed (suppressed) family reads as cancelled and a family the
 * scanner recorded as fixed reads as done; otherwise the effective workflow status wins.
 */
export function findingStatus(group: FindingGroup): FindingStatus {
  if (group.latest.triageStatus === "suppressed") return "cancelled";
  if (isFixedFinding(group)) return "done";
  return group.workflow?.status ?? "backlog";
}

export const isClosedFinding = (group: FindingGroup) => isClosedStatus(findingStatus(group));

/* ---------- presets ---------- */

export type FindingPreset = "all" | "review" | "fix-ready" | "closed";
export const PRESETS: readonly { value: FindingPreset; label: string }[] = [
  { value: "all", label: "All" },
  { value: "review", label: "Needs review" },
  { value: "fix-ready", label: "Fix ready" },
  { value: "closed", label: "Closed" },
];

export type FindingContext = { fixPrs: ReadonlyMap<string, string> };

export function matchesPreset(group: FindingGroup, preset: FindingPreset, context: FindingContext): boolean {
  const status = findingStatus(group);
  switch (preset) {
    case "review": {
      const gate = group.workflow?.reviewGate;
      return !isClosedStatus(status) && ((gate !== undefined && gate !== "none") || status === "blocked");
    }
    case "fix-ready": return !isClosedStatus(status) && context.fixPrs.has(group.latest.id);
    case "closed": return isClosedStatus(status);
    default: return true;
  }
}

/* ---------- search ---------- */

export function matchesFindingSearch(group: FindingGroup, query: string, extra = ""): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const { latest, workflow } = group;
  return [
    latest.title, latest.category, latest.severity, latest.triageStatus, latest.status, group.fingerprint, findingCode(group.fingerprint),
    workflow?.status, workflow?.phase, workflow?.reviewGate, workflow?.persistedStatus, workflow?.recommendedStatus, workflow?.reviewReason ?? "",
    workflow?.consensus, workflow?.assignee ?? "", workflow?.activeAgentRoles?.join(" ") ?? "", latest.impactAssessment?.blast_radius ?? "", extra,
  ].join(" ").toLowerCase().includes(normalized);
}

/* ---------- filters ---------- */

export type FindingFilters = {
  severity: SeverityLevel[];
  status: FindingStatus[];
  category: string[];
  mission: string[];
  hasFixPr: boolean;
  match: "all" | "any";
};
export const EMPTY_FILTERS: FindingFilters = { severity: [], status: [], category: [], mission: [], hasFixPr: false, match: "all" };

export const missionKey = (group: FindingGroup) => group.latest.scanId;

export function activeFilterCount(filters: FindingFilters): number {
  return Number(filters.severity.length > 0) + Number(filters.status.length > 0) + Number(filters.category.length > 0) + Number(filters.mission.length > 0) + Number(filters.hasFixPr);
}

/** Each active filter is one predicate; `match` decides whether all or any must hold. No filters passes everything. */
export function matchesFilters(group: FindingGroup, filters: FindingFilters, context: FindingContext): boolean {
  const checks: boolean[] = [];
  if (filters.severity.length) checks.push(filters.severity.includes(normalizeSeverity(group.latest.severity)));
  if (filters.status.length) checks.push(filters.status.includes(findingStatus(group)));
  if (filters.category.length) checks.push(filters.category.includes(group.latest.category));
  if (filters.mission.length) checks.push(filters.mission.includes(missionKey(group)));
  if (filters.hasFixPr) checks.push(context.fixPrs.has(group.latest.id));
  if (!checks.length) return true;
  return filters.match === "any" ? checks.some(Boolean) : checks.every(Boolean);
}

export const toggleValue = <T>(values: readonly T[], value: T): T[] => values.includes(value) ? values.filter(item => item !== value) : [...values, value];

/* ---------- display ---------- */

export type GroupBy = "status" | "severity" | "category" | "mission" | "none";
export type OrderBy = "severity" | "updated" | "seen" | "title" | "occurrences";
export type Direction = "asc" | "desc";
export type Layout = "list" | "board";
export type DisplayOptions = { layout: Layout; groupBy: GroupBy; orderBy: OrderBy; direction: Direction };
export const DEFAULT_DISPLAY: DisplayOptions = { layout: "list", groupBy: "status", orderBy: "severity", direction: "desc" };

export const GROUP_BY_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { value: "status", label: "Status" }, { value: "severity", label: "Severity" }, { value: "category", label: "Category" }, { value: "mission", label: missionLabel }, { value: "none", label: "No grouping" },
];
export const ORDER_BY_OPTIONS: readonly { value: OrderBy; label: string }[] = [
  { value: "severity", label: "Severity" }, { value: "updated", label: "Last updated" }, { value: "seen", label: "Last seen" }, { value: "title", label: "Title" }, { value: "occurrences", label: "Occurrences" },
];

const severityRank = (group: FindingGroup) => SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(normalizeSeverity(group.latest.severity));
const updatedAt = (group: FindingGroup) => {
  const parsed = group.workflow?.updatedAt ? Date.parse(group.workflow.updatedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : group.latest.timestamp;
};

/** Ascending = lowest first (info, oldest, A to Z, fewest). Ties fall back to newest then fingerprint so order is stable. */
export function sortFindings(groups: readonly FindingGroup[], orderBy: OrderBy, direction: Direction): FindingGroup[] {
  const sign = direction === "asc" ? 1 : -1;
  const primary = (a: FindingGroup, b: FindingGroup) => {
    switch (orderBy) {
      case "severity": return severityRank(a) - severityRank(b);
      case "updated": return updatedAt(a) - updatedAt(b);
      case "seen": return a.latest.timestamp - b.latest.timestamp;
      case "occurrences": return a.count - b.count;
      case "title": return a.latest.title.localeCompare(b.latest.title, undefined, { sensitivity: "base" });
    }
  };
  return [...groups].sort((a, b) => sign * primary(a, b) || b.latest.timestamp - a.latest.timestamp || a.fingerprint.localeCompare(b.fingerprint));
}

export type FindingSection = {
  key: string;
  label: string;
  kind: "status" | "severity" | "plain";
  status?: FindingStatus;
  severity?: SeverityLevel;
  items: FindingGroup[];
  closedByDefault: boolean;
};

export type MissionLabels = ReadonlyMap<string, string>;
export const missionName = (key: string, labels?: MissionLabels) => labels?.get(key) ?? `${missionLabel} ${key.slice(0, 8)}`;

/** Splits already-filtered findings into ordered sections. Empty sections are omitted. */
export function buildSections(groups: readonly FindingGroup[], display: Pick<DisplayOptions, "groupBy" | "orderBy" | "direction">, missions?: MissionLabels): FindingSection[] {
  const sorted = sortFindings(groups, display.orderBy, display.direction);
  if (!sorted.length) return [];
  if (display.groupBy === "none") return [{ key: "all", label: "", kind: "plain", items: sorted, closedByDefault: false }];
  const buckets = new Map<string, FindingGroup[]>();
  const keyOf = (group: FindingGroup) => {
    switch (display.groupBy) {
      case "status": return findingStatus(group);
      case "severity": return normalizeSeverity(group.latest.severity);
      case "category": return group.latest.category || "Uncategorized";
      default: return missionKey(group);
    }
  };
  for (const group of sorted) {
    const key = keyOf(group);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(group); else buckets.set(key, [group]);
  }
  if (display.groupBy === "status") {
    return STATUS_ORDER.filter(status => buckets.has(status)).map(status => ({ key: status, label: STATUS_LABEL[status], kind: "status" as const, status, items: buckets.get(status)!, closedByDefault: isClosedStatus(status) }));
  }
  if (display.groupBy === "severity") {
    return SEVERITY_ORDER.filter(level => buckets.has(level)).map(level => ({ key: level, label: SEVERITY_LABELS[level], kind: "severity" as const, severity: level, items: buckets.get(level)!, closedByDefault: false }));
  }
  const entries = [...buckets.entries()];
  if (display.groupBy === "category") entries.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return entries.map(([key, items]) => ({ key, label: display.groupBy === "mission" ? missionName(key, missions) : key, kind: "plain" as const, items, closedByDefault: false }));
}

/* ---------- flattened rows + windowing ---------- */

export const ROW_HEIGHT = 44;
export const ROW_STRIDE = 46;
export const HEADER_HEIGHT = 36;
export const HEADER_STRIDE = 40;

export type ListRow =
  | { type: "header"; key: string; section: FindingSection; collapsed: boolean }
  | { type: "finding"; key: string; group: FindingGroup; sectionKey: string };

export const isSectionCollapsed = (section: FindingSection, overrides: Readonly<Record<string, boolean>>) => overrides[section.key] ?? section.closedByDefault;

export function flattenSections(sections: readonly FindingSection[], overrides: Readonly<Record<string, boolean>>): ListRow[] {
  const rows: ListRow[] = [];
  for (const section of sections) {
    const collapsed = section.label ? isSectionCollapsed(section, overrides) : false;
    if (section.label) rows.push({ type: "header", key: `h:${section.key}`, section, collapsed });
    if (collapsed) continue;
    for (const group of section.items) rows.push({ type: "finding", key: `f:${section.key}:${group.fingerprint}`, group, sectionKey: section.key });
  }
  return rows;
}

export type RowLayout = { offsets: number[]; heights: number[]; total: number };
export function layoutRows(rows: readonly ListRow[]): RowLayout {
  const offsets: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const row of rows) {
    offsets.push(y);
    heights.push(row.type === "header" ? HEADER_HEIGHT : ROW_HEIGHT);
    y += row.type === "header" ? HEADER_STRIDE : ROW_STRIDE;
  }
  return { offsets, heights, total: y };
}

/** Half-open index range `[start, end)` of rows intersecting the viewport, widened by `overscan` rows. */
export function visibleRange(layout: RowLayout, scrollTop: number, viewport: number, overscan = 6): [number, number] {
  const { offsets, heights } = layout;
  const count = offsets.length;
  if (!count) return [0, 0];
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= scrollTop) low = mid; else high = mid - 1;
  }
  let end = low;
  const bottom = scrollTop + viewport;
  while (end < count && offsets[end]! < bottom) end += 1;
  return [Math.max(0, low - overscan), Math.min(count, end + overscan)];
}

/** Navigable findings in display order, skipping collapsed sections. */
export const navigableFingerprints = (rows: readonly ListRow[]) => rows.flatMap(row => row.type === "finding" ? [row.group.fingerprint] : []);

/** Index after moving `delta` through `ids`; starts at the first/last item when nothing is current. Clamped. */
export function stepCursor(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (!ids.length) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index === -1) return delta === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))]!;
}

/* ---------- board ---------- */

export type BoardColumn = { status: FindingStatus; label: string; items: FindingGroup[]; droppable: boolean };
export function boardColumns(groups: readonly FindingGroup[], orderBy: OrderBy, direction: Direction): BoardColumn[] {
  const sorted = sortFindings(groups, orderBy, direction);
  return BOARD_ORDER.map(status => ({
    status, label: STATUS_LABEL[status], items: sorted.filter(group => findingStatus(group) === status), droppable: SETTABLE_STATUSES.includes(status),
  }));
}

/** Mission label map from scans: target is the friendliest stable name. */
export function missionLabels(scans: readonly { id: string; target: string }[]): Map<string, string> {
  return new Map(scans.map(scan => [scan.id, scan.target || `${missionLabel} ${scan.id.slice(0, 8)}`]));
}

/** Distinct, sorted values with counts for the filter menu. */
export function facetCounts(groups: readonly FindingGroup[], pick: (group: FindingGroup) => string): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    const value = pick(group);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/* ---------- activity ---------- */

export type ActivityEvent = { id: string; at: number | null; kind: "detected" | "step" | "note"; text: string; detail?: string };

/**
 * Timeline from what the family endpoint returns: every recorded occurrence (oldest = first detection), the
 * agent work items (no timestamps, listed after) and the reviewer's note. Newest first.
 */
export function buildActivity(family: {
  rows: readonly { id: string; scanId: string; status: string; timestamp: number }[];
  workItems: readonly { id: string; title: string; status: string; owner: string | null; summary: string }[];
  latest: { triageNote?: string | null; triageStatus: string };
}): ActivityEvent[] {
  const rows = [...family.rows].sort((a, b) => a.timestamp - b.timestamp);
  const detections: ActivityEvent[] = rows.map((row, index) => ({
    id: `row:${row.id}`, at: row.timestamp, kind: "detected" as const,
    text: index === 0 ? "First detected" : "Detected again", detail: `Run ${row.scanId.slice(0, 8)} · recorded ${row.status.replaceAll("_", " ")}`,
  })).reverse();
  const steps: ActivityEvent[] = family.workItems.map(item => ({
    id: `step:${item.id}`, at: null, kind: "step", text: `${item.title} · ${item.status.replaceAll("_", " ")}`, detail: item.summary || undefined,
  }));
  const note: ActivityEvent[] = family.latest.triageNote?.trim()
    ? [{ id: "note", at: null, kind: "note", text: `Review note (${family.latest.triageStatus})`, detail: family.latest.triageNote.trim() }]
    : [];
  return [...note, ...detections, ...steps];
}

/* ---------- persisted view ---------- */

export const PANEL_DEFAULT_WIDTH = 520;
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 760;
export const clampPanelWidth = (width: number) => Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));

export type FindingsView = { display: DisplayOptions; preset: FindingPreset; filters: FindingFilters; collapsed: Record<string, boolean>; panelWidth: number };
export const DEFAULT_VIEW: FindingsView = { display: DEFAULT_DISPLAY, preset: "all", filters: EMPTY_FILTERS, collapsed: {}, panelWidth: PANEL_DEFAULT_WIDTH };

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Stored view state may predate a field or hold junk; anything unrecognised falls back to the default. */
export function mergeView(stored: unknown): FindingsView {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const display = (raw.display && typeof raw.display === "object" ? raw.display : {}) as Record<string, unknown>;
  const filters = (raw.filters && typeof raw.filters === "object" ? raw.filters : {}) as Record<string, unknown>;
  const collapsed: Record<string, boolean> = {};
  if (raw.collapsed && typeof raw.collapsed === "object") {
    for (const [key, value] of Object.entries(raw.collapsed)) if (typeof value === "boolean") collapsed[key] = value;
  }
  return {
    display: {
      layout: pick(display.layout, ["list", "board"], DEFAULT_DISPLAY.layout),
      groupBy: pick(display.groupBy, GROUP_BY_OPTIONS.map(option => option.value), DEFAULT_DISPLAY.groupBy),
      orderBy: pick(display.orderBy, ORDER_BY_OPTIONS.map(option => option.value), DEFAULT_DISPLAY.orderBy),
      direction: pick(display.direction, ["asc", "desc"], DEFAULT_DISPLAY.direction),
    },
    preset: pick(raw.preset, PRESETS.map(item => item.value), "all"),
    filters: {
      severity: strings(filters.severity).filter((level): level is SeverityLevel => (SEVERITY_ORDER as readonly string[]).includes(level)),
      status: strings(filters.status).filter((status): status is FindingStatus => (STATUS_ORDER as readonly string[]).includes(status)),
      category: strings(filters.category),
      mission: strings(filters.mission),
      hasFixPr: filters.hasFixPr === true,
      match: pick(filters.match, ["all", "any"], "all"),
    },
    collapsed,
    panelWidth: typeof raw.panelWidth === "number" && Number.isFinite(raw.panelWidth) ? clampPanelWidth(raw.panelWidth) : PANEL_DEFAULT_WIDTH,
  };
}
