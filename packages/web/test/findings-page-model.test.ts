import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY, EMPTY_FILTERS, HEADER_STRIDE, ROW_STRIDE, activeFilterCount, boardColumns, buildActivity, buildSections, clampPanelWidth, facetCounts, findingCode, findingStatus,
  flattenSections, layoutRows, matchesFilters, matchesFindingSearch, matchesPreset, mergeView, navigableFingerprints, sortFindings, stepCursor, visibleRange,
  type FindingsView,
} from "../src/components/findings/findings-model";
import type { FindingGroup, FindingWorkflowStatus } from "../src/types";

type Options = { severity?: string; status?: FindingWorkflowStatus; triage?: "new" | "accepted" | "suppressed"; recorded?: string; category?: string; scan?: string; count?: number; ts?: number; title?: string; gate?: "none" | "agent_review" | "human_review"; updatedAt?: string | null };
const group = (id: string, options: Options = {}): FindingGroup => ({
  fingerprint: `${id}-fingerprint`, count: options.count ?? 1, scanCount: 1,
  latest: { id: `id-${id}`, scanId: options.scan ?? "scan-a", title: options.title ?? `Title ${id}`, description: "", severity: options.severity ?? "medium", category: options.category ?? "xss", status: options.recorded ?? "discovered", triageStatus: options.triage ?? "new", timestamp: options.ts ?? 100, evidenceRequest: "", evidenceResponse: "" },
  workflow: { status: options.status ?? "backlog", phase: "backlog", reviewGate: options.gate ?? "none", updatedAt: options.updatedAt ?? null, consensus: "pending" } as FindingGroup["workflow"],
});
const context = { fixPrs: new Map([["id-a", "https://github.com/o/r/pull/7"]]) };

describe("finding codes", () => {
  it("derives F-<first 6 alphanumerics, upper-cased> and tolerates odd fingerprints", () => {
    expect(findingCode("3a9c1e77bd")).toBe("F-3A9C1E");
    expect(findingCode("sha256:ab-cd-ef-12")).toBe("F-SHA256");
    expect(findingCode("")).toBe("F-000000");
    expect(findingCode("ab")).toBe("F-AB");
  });
});

describe("status mapping", () => {
  it("uses the effective workflow status, with dismissal and recorded fixes closing a finding", () => {
    expect(findingStatus(group("a", { status: "human_review" }))).toBe("human_review");
    expect(findingStatus(group("a", { status: "in_progress", triage: "suppressed" }))).toBe("cancelled");
    expect(findingStatus(group("a", { status: "todo", recorded: "fixed" }))).toBe("done");
    expect(findingStatus({ ...group("a"), workflow: undefined as never })).toBe("backlog");
  });
  it("evaluates presets", () => {
    expect(matchesPreset(group("a", { gate: "human_review", status: "human_review" }), "review", context)).toBe(true);
    expect(matchesPreset(group("a", { status: "blocked" }), "review", context)).toBe(true);
    expect(matchesPreset(group("a", { status: "done", gate: "human_review" }), "review", context)).toBe(false);
    expect(matchesPreset(group("a"), "fix-ready", context)).toBe(true);
    expect(matchesPreset(group("b"), "fix-ready", context)).toBe(false);
    expect(matchesPreset(group("a", { status: "done" }), "fix-ready", context)).toBe(false);
    expect(matchesPreset(group("c", { triage: "suppressed" }), "closed", context)).toBe(true);
    expect(matchesPreset(group("c"), "all", context)).toBe(true);
  });
});

describe("filters and search", () => {
  const groups = [group("a", { severity: "critical", category: "sqli" }), group("b", { severity: "low", category: "xss", scan: "scan-b" })];
  it("matches all or any active filter and passes everything when none are set", () => {
    expect(groups.filter(item => matchesFilters(item, EMPTY_FILTERS, context))).toHaveLength(2);
    const both = { ...EMPTY_FILTERS, severity: ["critical" as const], category: ["xss"] };
    expect(groups.filter(item => matchesFilters(item, both, context))).toHaveLength(0);
    expect(groups.filter(item => matchesFilters(item, { ...both, match: "any" }, context))).toHaveLength(2);
    expect(groups.filter(item => matchesFilters(item, { ...EMPTY_FILTERS, hasFixPr: true }, context)).map(item => item.latest.id)).toEqual(["id-a"]);
    expect(groups.filter(item => matchesFilters(item, { ...EMPTY_FILTERS, mission: ["scan-b"] }, context)).map(item => item.latest.id)).toEqual(["id-b"]);
    expect(activeFilterCount(both)).toBe(2);
  });
  it("searches title, code and fingerprint", () => {
    expect(matchesFindingSearch(groups[0]!, "SQLI")).toBe(true);
    expect(matchesFindingSearch(groups[0]!, "f-afin")).toBe(true);
    expect(matchesFindingSearch(groups[0]!, "nothing here")).toBe(false);
    expect(matchesFindingSearch(groups[0]!, "  ")).toBe(true);
  });
  it("counts facets by frequency", () => {
    expect(facetCounts([...groups, group("c", { category: "xss" })], item => item.latest.category)).toEqual([{ value: "xss", count: 2 }, { value: "sqli", count: 1 }]);
  });
});

describe("ordering and grouping", () => {
  const items = [group("a", { severity: "low", ts: 5, title: "Beta", count: 9 }), group("b", { severity: "critical", ts: 1, title: "alpha", count: 1 }), group("c", { severity: "critical", ts: 9, title: "Gamma", count: 3 })];
  it("orders by each key in both directions with newest-first ties", () => {
    const ids = (list: FindingGroup[]) => list.map(item => item.latest.id.slice(3));
    expect(ids(sortFindings(items, "severity", "desc"))).toEqual(["c", "b", "a"]);
    expect(ids(sortFindings(items, "severity", "asc"))).toEqual(["a", "c", "b"]);
    expect(ids(sortFindings(items, "title", "asc"))).toEqual(["b", "a", "c"]);
    expect(ids(sortFindings(items, "occurrences", "desc"))).toEqual(["a", "c", "b"]);
    expect(ids(sortFindings(items, "seen", "desc"))).toEqual(["c", "a", "b"]);
    expect(ids(sortFindings([group("x", { ts: 1, updatedAt: "2030-01-01T00:00:00Z" }), group("y", { ts: Date.parse("2031-01-01") })], "updated", "desc"))).toEqual(["y", "x"]);
  });
  it("groups by status in priority order, folding closed ones", () => {
    const sections = buildSections([group("a", { status: "done" }), group("b", { status: "blocked" }), group("c"), group("d", { triage: "suppressed" })], DEFAULT_DISPLAY);
    expect(sections.map(section => section.key)).toEqual(["blocked", "backlog", "done", "cancelled"]);
    expect(sections.map(section => section.closedByDefault)).toEqual([false, false, true, true]);
  });
  it("groups by severity, category, mission and none", () => {
    expect(buildSections(items, { ...DEFAULT_DISPLAY, groupBy: "severity" }).map(section => section.key)).toEqual(["critical", "low"]);
    const byCategory = buildSections([group("a", { category: "x" }), group("b", { category: "y" }), group("c", { category: "y" })], { ...DEFAULT_DISPLAY, groupBy: "category" });
    expect(byCategory.map(section => [section.label, section.items.length])).toEqual([["y", 2], ["x", 1]]);
    const byMission = buildSections([group("a", { scan: "s1" })], { ...DEFAULT_DISPLAY, groupBy: "mission" }, new Map([["s1", "app.example.com"]]));
    expect(byMission[0]!.label).toBe("app.example.com");
    const none = buildSections(items, { ...DEFAULT_DISPLAY, groupBy: "none" });
    expect(none).toHaveLength(1);
    expect(flattenSections(none, {}).every(row => row.type === "finding")).toBe(true);
    expect(buildSections([], DEFAULT_DISPLAY)).toEqual([]);
  });
  it("builds board columns in lifecycle order with only settable columns droppable", () => {
    const columns = boardColumns([group("a", { status: "in_progress" }), group("b", { status: "human_review" })], "severity", "desc");
    expect(columns.map(column => column.status)).toEqual(["backlog", "todo", "in_progress", "agent_review", "human_review", "blocked", "done", "cancelled"]);
    expect(columns.find(column => column.status === "in_progress")!.items).toHaveLength(1);
    expect(columns.filter(column => !column.droppable).map(column => column.status)).toEqual(["agent_review", "human_review"]);
  });
});

describe("windowing", () => {
  const sections = buildSections(Array.from({ length: 200 }, (_, index) => group(String(index), { ts: index })), DEFAULT_DISPLAY);
  it("collapses closed sections by default and honours overrides", () => {
    const closed = buildSections([group("a"), group("b", { status: "done" })], DEFAULT_DISPLAY);
    expect(flattenSections(closed, {}).map(row => row.type)).toEqual(["header", "finding", "header"]);
    expect(flattenSections(closed, { done: false }).map(row => row.type)).toEqual(["header", "finding", "header", "finding"]);
    expect(flattenSections(closed, { backlog: true }).map(row => row.type)).toEqual(["header", "header"]);
    expect(navigableFingerprints(flattenSections(closed, { done: false }))).toEqual(["a-fingerprint", "b-fingerprint"]);
  });
  it("lays out headers and rows and returns a small visible window", () => {
    const rows = flattenSections(sections, {});
    const layout = layoutRows(rows);
    expect(layout.total).toBe(HEADER_STRIDE + 200 * ROW_STRIDE);
    const [start, end] = visibleRange(layout, 0, 600, 0);
    expect(start).toBe(0);
    expect(end).toBeLessThan(20);
    const [midStart, midEnd] = visibleRange(layout, 100 * ROW_STRIDE, 600, 2);
    expect(midStart).toBeGreaterThan(90);
    expect(midEnd - midStart).toBeLessThan(25);
    expect(visibleRange(layout, 1e9, 600, 3)[1]).toBe(rows.length);
    expect(visibleRange(layoutRows([]), 0, 600)).toEqual([0, 0]);
  });
  it("steps the keyboard cursor with clamping", () => {
    const ids = ["a", "b", "c"];
    expect(stepCursor(ids, null, 1)).toBe("a");
    expect(stepCursor(ids, null, -1)).toBe("c");
    expect(stepCursor(ids, "a", -1)).toBe("a");
    expect(stepCursor(ids, "c", 1)).toBe("c");
    expect(stepCursor(ids, "b", 1)).toBe("c");
    expect(stepCursor([], "b", 1)).toBeNull();
  });
});

describe("persisted view and activity", () => {
  it("falls back for junk and clamps the panel width", () => {
    const view = mergeView({ display: { layout: "grid", groupBy: "category", direction: 4 }, preset: "nope", filters: { severity: ["high", "bogus"], status: ["done", 3], match: "any", hasFixPr: true }, collapsed: { done: false, x: "y" }, panelWidth: 99999 }) as FindingsView;
    expect(view.display).toEqual({ layout: "list", groupBy: "category", orderBy: "severity", direction: "desc" });
    expect(view.preset).toBe("all");
    expect(view.filters).toMatchObject({ severity: ["high"], status: ["done"], match: "any", hasFixPr: true });
    expect(view.collapsed).toEqual({ done: false });
    expect(view.panelWidth).toBe(760);
    expect(mergeView(null).panelWidth).toBe(520);
    expect(clampPanelWidth(10)).toBe(360);
  });
  it("builds a newest-first activity timeline with steps and the review note", () => {
    const events = buildActivity({
      rows: [{ id: "r1", scanId: "scan-aaaaaaaaaa", status: "discovered", timestamp: 1 }, { id: "r2", scanId: "scan-bbbbbbbbbb", status: "verified", timestamp: 2 }],
      workItems: [{ id: "w1", title: "Blind verify", status: "in_progress", owner: null, summary: "Replaying" }],
      latest: { triageNote: " looks real ", triageStatus: "accepted" },
    });
    expect(events.map(event => event.text)).toEqual(["Review note (accepted)", "Detected again", "First detected", "Blind verify · in progress"]);
    expect(events[1]!.detail).toBe("Run scan-bbb · recorded verified");
    expect(events[0]!.detail).toBe("looks real");
  });
});
