import { describe, expect, it } from "vitest";
import type { FindingGroup, ScanRecord } from "@/types";
import type { PanelFix } from "@/console/panel/views/fixes-model";
import { WEEK_MS, activityStats, countLabel, findingStateRows, pullRequestRows, safePullRequestUrl } from "./settings-data-model";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const group = (status: string, severity = "high", ageMs = 1000, triage = "new"): FindingGroup => ({ fingerprint: `${status}-${severity}-${ageMs}`, count: 1, scanCount: 1, latest: { id: "f", scanId: "s", severity, status: "open", triageStatus: triage, timestamp: NOW - ageMs } as never, workflow: { status } as never });
const scan = (status: string, completedAt: string | null) => ({ id: "s", status, completedAt } as ScanRecord);
const fix = (patch: Record<string, unknown>, updatedAt = "2026-11-13T00:00:00Z"): PanelFix => ({ fix: { id: "x", finding: { id: "f", title: "SQLi" }, eligible: true, applied: false, ...patch } as never, workflowId: "w", updatedAt, active: false });

describe("findingStateRows", () => {
  it("lists every fixed state once, in lifecycle order, with counts and kind", () => {
    const rows = findingStateRows([group("backlog"), group("backlog"), group("done"), group("blocked")]);
    expect(rows.map(row => row.status)).toEqual(["backlog", "todo", "in_progress", "agent_review", "human_review", "blocked", "done", "cancelled"]);
    expect(rows.find(row => row.status === "backlog")).toMatchObject({ count: 2, kind: "Open", isDefault: true });
    expect(rows.find(row => row.status === "done")).toMatchObject({ count: 1, kind: "Closed", isDefault: false });
    expect(rows.find(row => row.status === "todo")?.count).toBe(0);
  });
  it("counts dismissed families as cancelled", () => {
    expect(findingStateRows([group("todo", "low", 1, "suppressed")]).find(row => row.status === "cancelled")?.count).toBe(1);
  });
});

describe("activityStats", () => {
  it("reports an honest empty window", () => {
    expect(activityStats({ scans: [], groups: [], sessions: [], fixes: [], now: NOW }).empty).toBe(true);
  });
  it("counts only the last seven days and skips blank chats", () => {
    const stats = activityStats({
      now: NOW,
      scans: [scan("completed", "2026-11-13T00:00:00Z"), scan("completed", "2026-10-01T00:00:00Z"), scan("failed", "2026-11-13T00:00:00Z")],
      groups: [group("todo", "critical"), group("todo", "Informational"), group("todo", "high", WEEK_MS + 5000)],
      sessions: [{ createdAt: "2026-11-12T00:00:00Z", messageCount: 3 }, { createdAt: "2026-11-12T00:00:00Z", messageCount: 0 }, { createdAt: "2026-10-01T00:00:00Z", messageCount: 9 }],
      fixes: [fix({ result: {} }), fix({ applied: true, result: {} }), fix({ published: { prUrl: "https://github.com/a/b/pull/1" }, applied: true }), fix({ result: {} }, "2026-10-01T00:00:00Z"), fix({})],
    });
    expect(stats).toMatchObject({ missions: 1, scansCompleted: 1, findingsFound: 2, fixesProposed: 3, fixesApplied: 2, pullRequests: 1, empty: false });
    expect(stats.findingsBySeverity).toMatchObject({ critical: 1, info: 1, high: 0 });
  });
});

describe("pull requests", () => {
  it("lists only published fixes, newest first", () => {
    const rows = pullRequestRows([fix({ id: "a", published: { prUrl: "https://github.com/a/b/pull/1", branch: "0/a" } }, "2026-11-01T00:00:00Z"), fix({ id: "b" }), fix({ id: "c", publication: { title: "Fix SQLi", baseBranch: "main" }, published: { prUrl: "https://github.com/a/b/pull/2", branch: "0/c" } })]);
    expect(rows.map(row => row.id)).toEqual(["c", "a"]);
    expect(rows[0]).toMatchObject({ title: "Fix SQLi", baseBranch: "main", branch: "0/c" });
  });
  it("only links web URLs and pluralises counts", () => {
    expect(safePullRequestUrl("javascript:alert(1)")).toBeUndefined();
    expect(safePullRequestUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    expect(countLabel(1, "finding")).toBe("1 finding");
    expect(countLabel(0, "finding")).toBe("0 findings");
  });
});
