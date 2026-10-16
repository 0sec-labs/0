import { describe, expect, it } from "vitest";
import type { HerdSubagentRecord, HerdSubagentMap } from "../herd-layout.js";
import {
  agentChatSwitcherShortcut,
  agentChatWorkItems,
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
    expect(rows.find((row) => row.id === "opaque-running-id")?.activity).toContain("Checking invoice access");
    expect(rows.find((row) => row.id === "opaque-completed-id")?.activity).toContain("incomplete");
    expect(rows.find((row) => row.id === "opaque-failed-id")?.activity).toContain("panic in decoder");
    expect(rows.find((row) => row.id === "opaque-untitled-id")?.activity).toContain("read_file");
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
    const rows = agentChatWorkItems(agents);
    expect(rows[0]?.activity).toContain("cookie tampering");
    expect(rows[1]?.activity).toContain("confirmed replay injection");
    expect(rows[1]?.activity).not.toContain("stale cookie tampering");
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
          + layout.visibleRows.reduce((sum, { row }) => sum + row.height + layout.separatorHeight, 0)
          + (layout.showMore ? 1 : 0);
        expect(layout.width).toBe(width);
        expect(layout.height).toBe(paintedRows);
        expect(layout.height).toBeLessThanOrEqual(height);
        expect(layout.heightLimit).toBe(height);
        expect(paintedRows).toBeLessThanOrEqual(height);
        expect(layout.visibleTabs.some((tab) => tab.id === selectedAgentId)).toBe(true);
        expect(layout.visibleTabs.length + layout.hiddenCount).toBe(tabs.length);
        expect(layout.showMore).toBe(layout.hiddenCount > 0);
      }
    }
  });

  it("shows a same-list remainder that selects the next hidden worker", () => {
    const layout = computeAgentWorkListLayout(tabs, "worker-11", 40, 16);
    expect(layout.visibleTabs.some((tab) => tab.id === "worker-11")).toBe(true);
    const next = nextHiddenAgentChatWorkItemId(tabs, layout.visibleTabs);
    expect(next).not.toBeNull();
    expect(layout.visibleTabs.some((tab) => tab.id === next)).toBe(false);
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

  it("leaves plain composer arrows unclaimed for list scrolling", () => {
    expect(agentChatSwitcherShortcut({ name: "up" })).toBeNull();
    expect(agentChatSwitcherShortcut({ name: "down" })).toBeNull();
    expect(agentChatSwitcherShortcut({ name: "pageup", ctrl: true })).toBe("previous");
    expect(agentChatSwitcherShortcut({ name: "end", ctrl: true, shift: true })).toBeNull();
  });
});
