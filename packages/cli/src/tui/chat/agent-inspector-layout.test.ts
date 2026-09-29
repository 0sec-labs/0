import { describe, expect, it } from "vitest";
import type { HerdSubagentMap } from "../herd-layout.js";
import { applyCommsMessage, computeCommsEdges } from "../agents-comms-layout.js";
import { computeAgentInspectorLayout, inspectorLineage, inspectorMessages, inspectorTabWindow } from "./agent-inspector-layout.js";

const agents: HerdSubagentMap = {
  a: { agentId: "a", name: "Alpha", parentScanId: "root", task: "Inspect", status: "running", maxTurns: 4, lastSeen: 0, activity: [] },
  b: { agentId: "b", name: "Beta", parentScanId: "a", task: "Review", status: "queued", maxTurns: 4, lastSeen: 0, activity: [] },
};

describe("agent inspector boundaries", () => {
  it("shows spawn ancestry without inventing unknown parents or looping on cycles", () => {
    expect(inspectorLineage(agents, "b", "root")).toBe("Main → Alpha → Beta");
    expect(inspectorLineage({ ...agents, a: { ...agents.a!, parentScanId: "missing" } }, "a", "root"))
      .toBe("missing → Alpha");
    expect(inspectorLineage({ ...agents, a: { ...agents.a!, parentScanId: "b" } }, "a", "root"))
      .toBe("[parent cycle] → Beta → Alpha");
  });

  it("joins real ID/name endpoints without counting broadcasts as delivery to every descendant", () => {
    let stream = applyCommsMessage([], { from: "Alpha", to: "Beta", body: "first", ts: 1 }, 1);
    stream = applyCommsMessage(stream, { from: "a", to: "b", body: "second", ts: 2 }, 2);
    stream = applyCommsMessage(stream, { from: "Alpha", to: "all", body: "broadcast", ts: 3 }, 3);
    stream = applyCommsMessage(stream, { from: "Other", to: "Main", body: "unrelated", ts: 4 }, 4);
    const betaTraffic = inspectorMessages(agents, stream, "b");
    expect(betaTraffic.map((message) => message.body)).toEqual(["first", "second"]);
    expect(computeCommsEdges(betaTraffic)).toEqual([{ from: "a", to: "b", count: 2 }]);
    expect(inspectorMessages(agents, stream, "a").map((message) => message.body))
      .toEqual(["first", "second", "broadcast"]);
  });

  it("reserves bounded chrome and keeps the selected tab reachable across resizes", () => {
    for (let width = 0; width <= 100; width++) {
      for (let height = 0; height <= 30; height++) {
        const layout = computeAgentInspectorLayout(width, height);
        expect(layout.tabsRows + layout.actionsRows + layout.bodyRows + layout.hintRows).toBe(height);
        expect(layout.bodyRows).toBeGreaterThanOrEqual(0);
        expect(layout.textWidth + layout.paddingX * 2).toBeLessThanOrEqual(width);
        if (height >= 3) expect(layout.bodyRows).toBeGreaterThanOrEqual(1);
      }
      for (let selected = 0; selected < 12; selected++) {
        const window = inspectorTabWindow(12, selected, width);
        expect(window.start).toBeLessThanOrEqual(selected);
        expect(window.end).toBeGreaterThan(selected);
        expect(window.tabWidth * (window.end - window.start) + window.arrowWidth * 2).toBeLessThanOrEqual(width);
      }
    }
  });
});
