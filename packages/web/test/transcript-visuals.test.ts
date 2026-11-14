import { expect, test } from "vitest";
import type { ConsoleSessionSnapshot, DesktopConsoleEvent } from "@0/engine/shared";
import { reduceConversation, reduceTurns, type TurnSegment } from "../src/console/transcript.js";
import { visualsFromSnapshot } from "../src/console/visuals.js";

const base = { schemaVersion: 1, sessionId: "chat-a", occurredAt: "2026-10-08T12:00:00Z" };
const ev = (sequence: number, rest: Record<string, unknown>) => ({ ...base, sequence, ...rest }) as unknown as DesktopConsoleEvent;
const visualPayload = (id: string, title = "Attack path") => ({ id, version: 1, kind: "graph", title, summary: "Two hosts", spec: { nodes: [{ id: "a", label: "A" }], edges: [] } });
const types = (segments: TurnSegment[] | undefined) => segments?.map(segment => segment.type);
const tool = (id: string, name = "bash", args: unknown = {}) => ({ id, name, arguments: args });
const savedInput = (savedMessages_: typeof savedMessages) => (savedMessages_[1]!.content[0] as { input: unknown }).input;

test("a visual event is its own segment between the tool batch and later text", () => {
  const [turn] = reduceTurns([
    ev(1, { type: "user", text: "map it" }),
    ev(2, { type: "tool-start", call: tool("t1", "visualize") }),
    ev(3, { type: "tool-result", call: tool("t1", "visualize"), result: "visual_id=v1" }),
    ev(4, { type: "visual", visual: visualPayload("v1") }),
    ev(5, { type: "assistant-delta", text: "Done." }),
  ], "ready");
  expect(types(turn.segments)).toEqual(["tools", "visual", "assistant"]);
  expect(turn.visuals?.map(visual => visual.id)).toEqual(["v1"]);
});

test("a later tool batch starts a new segment after the visual, preserving order", () => {
  const [turn] = reduceTurns([
    ev(1, { type: "user", text: "go" }),
    ev(2, { type: "tool-start", call: tool("t1") }),
    ev(3, { type: "visual", visual: visualPayload("v1") }),
    ev(4, { type: "tool-start", call: tool("t2") }),
    ev(5, { type: "visual", visual: visualPayload("v2", "Second") }),
  ], "ready");
  expect(types(turn.segments)).toEqual(["tools", "visual", "tools", "visual"]);
  expect(turn.visuals?.map(visual => visual.id)).toEqual(["v1", "v2"]);
});

test("replayed visual events and malformed or unknown events do not duplicate or break", () => {
  const [turn] = reduceTurns([
    ev(1, { type: "user", text: "go" }),
    ev(2, { type: "visual", visual: visualPayload("v1") }),
    ev(3, { type: "visual", visual: visualPayload("v1") }),
    ev(4, { type: "visual", visual: { id: "bad" } }),
    ev(5, { type: "visual", visual: null }),
    ev(6, { type: "future-event", payload: 1 }),
  ], "ready");
  expect(turn.visuals).toHaveLength(1);
  expect(types(turn.segments)).toEqual(["visual"]);
});

const savedMessages = [
  { role: "user", content: [{ type: "text", text: "map it" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "visualize", input: { kind: "graph", title: "Attack path", summary: "Two hosts", spec: { nodes: [{ id: "a", label: "A" }], edges: [] } } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "visual_id=v1" }] },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
];
const snapshotOf = (events: DesktopConsoleEvent[], messages: unknown[] = savedMessages) => ({
  session: { id: "chat-a", status: "ready" }, pendingDecisions: [], lastOutcome: null, cursor: 9, messages, events, workers: [], tools: [],
}) as unknown as ConsoleSessionSnapshot;

test("saved messages rebuild the visual from the visualize tool call", () => {
  const [turn] = reduceConversation(snapshotOf([]));
  expect(types(turn.segments)).toEqual(["tools", "visual", "assistant"]);
  expect(turn.visuals?.[0]).toMatchObject({ id: "tu1", kind: "graph", title: "Attack path" });
});

test("a saved visualize call and its live event collapse to one visual at the saved position", () => {
  const [turn] = reduceConversation(snapshotOf([
    ev(1, { type: "user", text: "map it" }),
    ev(2, { type: "tool-start", call: tool("gw1", "visualize", savedInput(savedMessages)) }),
    ev(3, { type: "visual", visual: visualPayload("v1") }),
    ev(4, { type: "assistant-delta", text: "Done." }),
  ]));
  expect(turn.visuals).toHaveLength(1);
  expect(types(turn.segments)).toEqual(["tools", "visual", "assistant"]);
});

test("a journal-only visual is added after the tool it followed", () => {
  const [turn] = reduceConversation(snapshotOf([
    ev(1, { type: "user", text: "map it" }),
    ev(2, { type: "tool-start", call: tool("tu1", "visualize") }),
    ev(3, { type: "visual", visual: visualPayload("v1") }),
    ev(4, { type: "visual", visual: visualPayload("v2", "Extra") }),
  ]));
  expect(turn.visuals?.map(visual => visual.title)).toEqual(["Attack path", "Extra"]);
  expect(types(turn.segments)).toEqual(["tools", "visual", "visual", "assistant"]);
});

test("the Visuals view list matches the transcript and ignores invalid saved calls", () => {
  const messages = [...savedMessages, { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "visualize", input: { kind: "graph" } }] }];
  const events = [ev(1, { type: "visual", visual: visualPayload("v1") }), ev(2, { type: "visual", visual: visualPayload("v9", "Live only") })];
  expect(visualsFromSnapshot(snapshotOf(events, messages)).map(visual => visual.title)).toEqual(["Attack path", "Live only"]);
});
