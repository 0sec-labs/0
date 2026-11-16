import { describe, expect, test } from "vitest";
import { agentBadge, agentRow, agentSubtitle, folderMonogram, folderName, resolveListMode, sortAgents, threadSubline } from "../src/lib/sidebar-rows";
import { formatRelativeAge } from "../src/lib/relative-time";
import type { Sentinel } from "../src/sentinels/model";

const agent = (patch: Partial<Sentinel> = {}) => ({ id: "a1", name: "Pen Tester", mission: "Probe the staging app", status: "active", updatedAt: "2026-01-01T00:00:00Z", ...patch }) as Sentinel;

describe("age", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  test("compact units", () => {
    expect(formatRelativeAge(now - 30_000, now)).toBe("now");
    expect(formatRelativeAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatRelativeAge(now - 3 * 3600_000, now)).toBe("3h");
    expect(formatRelativeAge(now - 2 * 86400_000, now)).toBe("2d");
    expect(formatRelativeAge(now - 9 * 86400_000, now)).toBe("1w");
    expect(formatRelativeAge(Number.NaN, now)).toBe("");
  });
});

describe("list mode", () => {
  test("defaults and stored choice", () => {
    expect(resolveListMode(null, 0, true)).toBe("threads");
    expect(resolveListMode(null, 2, true)).toBe("agents");
    expect(resolveListMode("threads", 2, true)).toBe("threads");
    expect(resolveListMode("agents", 0, true)).toBe("agents");
    expect(resolveListMode("agents", 2, false)).toBe("threads");
  });
});

describe("agent badge and subtitle", () => {
  test("badge priority", () => {
    expect(agentBadge(agent({ attention: { needsYou: true, needsReview: false, pendingDecisions: 1 } }), true)).toBe("needs-you");
    expect(agentBadge(agent({ attention: { needsYou: false, needsReview: true, pendingDecisions: 0 } }))).toBe("needs-you");
    expect(agentBadge(agent({ status: "paused" }), true)).toBe("paused");
    expect(agentBadge(agent(), true)).toBe("running");
    expect(agentBadge(agent())).toBe("idle");
  });
  test("subtitle falls back to the job line", () => {
    expect(agentSubtitle(agent())).toEqual({ text: "Probe the staging app", tone: "muted" });
    expect(agentSubtitle(agent({ status: "paused", pauseReason: { kind: "budget", message: "Daily budget reached", at: "" } }))).toEqual({ text: "Daily budget reached", tone: "muted" });
    expect(agentSubtitle(agent({ attention: { needsYou: true, needsReview: false, pendingDecisions: 1 } }))).toEqual({ text: "Needs you", tone: "accent" });
    expect(agentSubtitle(agent({ attention: { needsYou: true, needsReview: false, pendingDecisions: 1, reason: "Approve the scan" } })).text).toBe("Approve the scan");
  });
  test("row", () => {
    expect(agentRow(agent(), Date.parse("2026-01-03T00:00:00Z"))).toMatchObject({ href: "/agents/a1", age: "2d", badge: "idle", badgeLabel: "Idle" });
  });
  test("sort by name", () => {
    const list = [agent({ id: "2", name: "b" }), agent({ id: "1", name: "a" })];
    expect(sortAgents(list, "name").map(item => item.name)).toEqual(["a", "b"]);
    expect(sortAgents(list, "recent").map(item => item.name)).toEqual(["b", "a"]);
  });
});

describe("thread subline", () => {
  test("attention wins, else folder and computer", () => {
    expect(threadSubline({ attention: "Waiting for you", workspacePath: "/x/app", computer: "Mac" })).toEqual({ kind: "needs-you", text: "Waiting for you" });
    expect(threadSubline({ workspacePath: "/x/app/", computer: "Mac" })).toEqual({ kind: "place", folder: "app", computer: "Mac" });
    expect(threadSubline({ computer: "Mac" })).toEqual({ kind: "place", folder: "", computer: "Mac" });
    expect(folderName("C:\\a\\b")).toBe("b");
    expect(folderMonogram("live")).toBe("L");
  });
});
