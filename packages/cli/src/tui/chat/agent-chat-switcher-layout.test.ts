import { describe, expect, it } from "vitest";
import type { HerdSubagentRecord, HerdSubagentMap } from "../herd-layout.js";
import {
  agentChatSwitcherShortcut,
  agentChatWorkItems,
  agentWorkListHeight,
  computeAgentWorkListLayout,
  nextHiddenAgentChatWorkItemId,
  type AgentChatTab,
} from "./agent-chat-switcher-layout.js";

function record(
  agentId: string,
  status: HerdSubagentRecord["status"],
  task: string,
  extras: Partial<HerdSubagentRecord> = {},
): HerdSubagentRecord {
  return {
    agentId,
    name: "RandomCallsign",
    parentScanId: "root",
    task,
    status,
    maxTurns: 4,
    lastSeen: 0,
    activity: [],
    ...extras,
  };
}

describe("agentChatWorkItems", () => {
  it("uses task labels, current activity, and truthful lifecycle wording without callsigns or ids", () => {
    const agents: HerdSubagentMap = {
      queued: record("opaque-queued-id", "queued", "# Goal: Enumerate authenticated endpoints"),
      running: record("opaque-running-id", "running", "Map authorization checks", { note: "Checking invoice access" }),
      completed: record("opaque-completed-id", "completed", "Summarize findings", { done: false }),
      failed: record("opaque-failed-id", "failed", "Find the crash", { error: "panic in decoder" }),
      parked: record("opaque-parked-id", "parked", "Inspect parked work"),
      untitled: record("opaque-untitled-id", "running", "", { tool: "read_file" }),
    };

    const rows = agentChatWorkItems(agents);
    expect(rows.map(({ label }) => label)).toEqual([
      "Enumerate authenticated endpoints",
      "Map authorization checks",
      "Summarize findings",
      "Find the crash",
      "Inspect parked work",
      "Worker",
    ]);
    expect(rows.map(({ activity }) => activity)).toEqual([
      "queued · waiting to start",
      "running · Checking invoice access",
      "completed · incomplete",
      "failed · panic in decoder",
      "parked",
      "running · using read_file",
    ]);
    expect(rows.every((row) => !row.label.includes("opaque-") && !row.label.includes("RandomCallsign"))).toBe(true);
  });
  it("prefers the latest recorded progress note over a tool mirror and completion summary over stale notes", () => {
    const progress = [
      { kind: "progress" as const, ts: 1, tool: "replay" },
      { kind: "progress" as const, ts: 2, note: "cookie tampering" },
    ];
    const agents: HerdSubagentMap = {
      running: record("running-id", "running", "Review session handling", {
        tool: "replay",
        activity: progress,
      }),
      completed: record("completed-id", "completed", "Confirm the finding", {
        tool: "replay",
        note: "stale cookie tampering",
        done: true,
        summary: "confirmed replay injection",
        completionReason: "done",
        activity: [...progress, { kind: "lifecycle", ts: 3, status: "completed" as const }],
      }),
    };
    expect(agentChatWorkItems(agents).map(({ activity }) => activity)).toEqual([
      "running · cookie tampering",
      "completed · confirmed replay injection",
    ]);
  });
});

describe("computeAgentWorkListLayout", () => {
  const tabs: AgentChatTab[] = Array.from({ length: 12 }, (_, index) => ({
    id: `worker-${index}`,
    label: `Task ${index}`,
    status: index % 2 === 0 ? "running" : "queued",
    activity: index % 2 === 0 ? "running · inspect" : "queued · waiting to start",
  }));

  it("keeps a cursor-adjacent window within the requested height and accounts for every hidden worker", () => {
    for (const width of [120, 80, 40, 12]) {
      for (const height of [16, 36]) {
        const selectedAgentId = "worker-7";
        const layout = computeAgentWorkListLayout(tabs, selectedAgentId, width, height);
        const paintedRows = layout.mainHeight
          + layout.visibleTabs.length * (layout.itemHeight + layout.separatorHeight)
          + (layout.showMore ? 1 : 0);
        expect(layout.width).toBe(width);
        expect(layout.height).toBe(paintedRows);
        expect(layout.height).toBeLessThanOrEqual(height);
        expect(layout.heightLimit).toBe(height);
        expect(agentWorkListHeight(tabs.length, height)).toBe(layout.height);
        expect(paintedRows).toBeLessThanOrEqual(height);
        expect(layout.visibleTabs.some((tab) => tab.id === selectedAgentId)).toBe(true);
        expect(layout.visibleTabs.length + layout.hiddenCount).toBe(tabs.length);
        expect(layout.showMore).toBe(layout.hiddenCount > 0);
      }
    }
  });

  it("shows a same-list remainder that selects the next hidden worker", () => {
    const layout = computeAgentWorkListLayout(tabs, "worker-11", 40, 16);
    expect(layout.visibleTabs.map((tab) => tab.id)).toEqual(["worker-8", "worker-9", "worker-10", "worker-11"]);
    expect(layout.hiddenCount).toBe(8);
    expect(layout.showMore).toBe(true);
    expect(nextHiddenAgentChatWorkItemId(tabs, layout.visibleTabs)).toBe("worker-0");
  });

  it("cycles the bounded window until every retained worker has been selected", () => {
    const reached = new Set<string>();
    let selectedId: string | null = null;
    for (let step = 0; step < tabs.length + 1; step += 1) {
      const layout = computeAgentWorkListLayout(tabs, selectedId, 40, 16);
      for (const tab of layout.visibleTabs) reached.add(tab.id);
      const nextId = nextHiddenAgentChatWorkItemId(tabs, layout.visibleTabs);
      if (nextId === null || reached.has(nextId)) break;
      selectedId = nextId;
    }
    expect(reached).toEqual(new Set(tabs.map((tab) => tab.id)));
  });
  it("does not reserve an overflow row when every worker fits", () => {
    const layout = computeAgentWorkListLayout(tabs.slice(0, 2), null, 80, 16);
    expect(layout.visibleTabs.map((tab) => tab.id)).toEqual(["worker-0", "worker-1"]);
    expect(layout.hiddenCount).toBe(0);
    expect(layout.showMore).toBe(false);
  });

  it("returns the natural row budget needed for the list without exceeding its caller cap", () => {
    expect(agentWorkListHeight(0, 16)).toBe(3);
    expect(agentWorkListHeight(2, 16)).toBe(9);
    expect(agentWorkListHeight(12, 16)).toBe(16);
    expect(agentWorkListHeight(12, 36)).toBe(34);
    expect(agentWorkListHeight(12, 0)).toBe(0);
  });

  it("leaves plain composer arrows unclaimed for list scrolling", () => {
    expect(agentChatSwitcherShortcut({ name: "up" })).toBeNull();
    expect(agentChatSwitcherShortcut({ name: "down" })).toBeNull();
    expect(agentChatSwitcherShortcut({ name: "pageup", ctrl: true })).toBe("previous");
    expect(agentChatSwitcherShortcut({ name: "end", ctrl: true, shift: true })).toBeNull();
  });
});
