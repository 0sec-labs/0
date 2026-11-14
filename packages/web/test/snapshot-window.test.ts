import { describe, expect, it } from "vitest";
import type { ConsolePublicMessage, DesktopConsoleEvent } from "@0/engine/shared";
import { expandSummaryWorkers, hasOlderMessages, mergeWindowedSnapshot, needsWorkerDetail, prependMessages, withWorkerDetail, type WindowedSnapshot } from "../src/console/snapshot-window";

const message = (index: number): ConsolePublicMessage => ({ role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `m${index}` }] }) as ConsolePublicMessage;
const event = (sequence: number, type = "notice"): DesktopConsoleEvent => ({ sequence, type, text: `e${sequence}` }) as unknown as DesktopConsoleEvent;
function snapshot(first: number, total: number, events: number[], extra: Partial<WindowedSnapshot> = {}): WindowedSnapshot {
  const messages = Array.from({ length: total - first }, (_, index) => message(first + index));
  return { session: { id: "s1", status: "ready" }, cursor: events.at(-1) ?? 0, messages, events: events.map(sequence => event(sequence)), workers: [], tools: [], queuedMessages: [], pendingDecisions: [], toolsOmitted: true,
    window: { messages: messages.length, messagesTotal: total, firstMessageIndex: total ? first : null, events: events.length, eventsTotal: events.length, workers: "full" }, ...extra } as unknown as WindowedSnapshot;
}
const summary = { id: "w1", parentId: "root", name: "scout", status: "running", task: "t", telemetry: { cost: 1 }, turnCount: 3, toolCallCount: 2, operatorMessageCount: 0 };

describe("windowed snapshots", () => {
  it("gives summary workers an empty transcript and marks them for lazy detail", () => {
    const next = expandSummaryWorkers(snapshot(0, 2, [1], { workers: [summary] as never, window: { ...snapshot(0, 2, [1]).window!, workers: "summary" } }));
    expect(next.workers[0]!.transcript).toEqual([]);
    expect(needsWorkerDetail(next, "w1")).toBe(true);
    expect(needsWorkerDetail(next, "missing")).toBe(false);
  });
  it("passes legacy full snapshots through untouched", () => {
    const legacy = { ...snapshot(0, 2, [1]), window: undefined, toolsOmitted: undefined } as WindowedSnapshot;
    expect(mergeWindowedSnapshot(null, legacy)).toBe(legacy);
    expect(hasOlderMessages(legacy)).toBe(false);
  });
  it("keeps older pages and earlier events when the window slides", () => {
    const paged = prependMessages(snapshot(100, 160, [10, 11]), { messages: Array.from({ length: 50 }, (_, index) => message(50 + index)), firstIndex: 50 });
    expect(paged.messages).toHaveLength(110);
    expect(paged.window!.firstMessageIndex).toBe(50);
    const merged = mergeWindowedSnapshot(paged, snapshot(102, 162, [11, 12, 13]));
    expect(merged.messages).toHaveLength(112);
    expect(merged.messages[0]).toEqual(message(50));
    expect(merged.messages.at(-1)).toEqual(message(161));
    expect(merged.window!.firstMessageIndex).toBe(50);
    expect(merged.events.map(item => item.sequence)).toEqual([10, 11, 12, 13]);
  });
  it("drops history when it shrank or events were cleared", () => {
    const previous = snapshot(0, 100, [1, 2]);
    expect(mergeWindowedSnapshot(previous, snapshot(0, 0, [3, 4])).messages).toHaveLength(0);
    const cleared = { ...snapshot(0, 2, [3, 4]), events: [event(3, "clear"), event(4)] } as WindowedSnapshot;
    expect(mergeWindowedSnapshot(snapshot(0, 2, [1, 2]), cleared).events.map(item => item.sequence)).toEqual([3, 4]);
  });
  it("merges a fetched worker without losing newer event turns and survives later summaries", () => {
    const base = expandSummaryWorkers(snapshot(0, 2, [1], { workers: [summary] as never, window: { ...snapshot(0, 2, [1]).window!, workers: "summary" } }));
    const live = { ...base, workers: [{ ...base.workers[0]!, transcript: [{ turn: 4, ts: 4 }] }] } as unknown as WindowedSnapshot;
    const loaded = withWorkerDetail(live, { ...summary, transcript: [{ turn: 1, ts: 1 }, { turn: 2, ts: 2 }], operatorMessages: [] } as never);
    expect(loaded.workers[0]!.transcript.map(turn => turn.turn)).toEqual([1, 2, 4]);
    expect(needsWorkerDetail(loaded, "w1")).toBe(false);
    const refreshed = mergeWindowedSnapshot(loaded, { ...base, cursor: 9 } as WindowedSnapshot);
    expect(refreshed.workers[0]!.transcript).toHaveLength(3);
    expect(needsWorkerDetail(refreshed, "w1")).toBe(false);
  });
});
