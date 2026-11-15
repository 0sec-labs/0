import { describe, expect, it } from "vitest";
import { reduceConversation, reduceTurns } from "../src/console/transcript";
import { groupFinishedCalls, groupSummary } from "../src/console/tool-groups";

const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use" as const, id, name, input });
const done = (id: string, content = "ok") => ({ type: "tool_result" as const, tool_use_id: id, content });
const snapshot = (messages: unknown[], events: unknown[], status = "working") =>
  ({ session: { status }, messages, events, pendingDecisions: [], cursor: 99 }) as never;
const user = (text = "go") => ({ role: "user", content: [{ type: "text", text }] });

describe("one row per call", () => {
  it("reopening a round blocked on one call shows only that call as running; calls behind it have not started", () => {
    const assistant = { role: "assistant", content: ["list_files", "read_file", "ask_operator", "list_tools"].map((name, i) => use(`p${i}`, name)) };
    const events = [
      { type: "user", sequence: 1, text: "go" },
      { type: "tool-start", sequence: 2, call: { id: "g0", name: "list_files", arguments: {} } },
      { type: "tool-result", sequence: 3, call: { id: "g0", name: "list_files" }, result: "a" },
      { type: "tool-start", sequence: 4, call: { id: "g1", name: "read_file", arguments: {} } },
      { type: "tool-result", sequence: 5, call: { id: "g1", name: "read_file" }, result: "b" },
      { type: "tool-start", sequence: 6, call: { id: "g2", name: "ask_operator", arguments: {} } },
    ];
    const [turn] = reduceConversation(snapshot([user(), assistant], events));
    expect(turn!.toolCalls).toHaveLength(4);
    expect(turn!.toolCalls.filter(call => call.isRunning).map(call => call.name)).toEqual(["ask_operator"]);
    expect(turn!.toolCalls.find(call => call.name === "list_tools")).toMatchObject({ isRunning: false, queued: true });
  });

  it("with no journal at all, the first unfinished call is the active one and the rest queue", () => {
    const assistant = { role: "assistant", content: [use("a", "read_file"), use("b", "read_file", { path: "x" })] };
    const [turn] = reduceConversation(snapshot([user(), assistant], []));
    expect(turn!.toolCalls.map(call => [call.isRunning, Boolean(call.queued)])).toEqual([[true, false], [false, true]]);
  });

  it("a finished round has no running or queued calls even without results", () => {
    const assistant = { role: "assistant", content: [use("a", "read_file"), use("b", "read_file")] };
    const [turn] = reduceConversation(snapshot([user(), assistant], [], "ready"));
    expect(turn!.toolCalls.every(call => !call.isRunning && !call.queued)).toBe(true);
  });

  it("committed and journal copies of one call merge into a single row that finishes in place", () => {
    const args = { path: "package.json" };
    const assistant = { role: "assistant", content: [use("provider-1", "read_file", args)] };
    const events = [
      { type: "user", sequence: 1, text: "go" },
      { type: "tool-start", sequence: 2, call: { id: "gw-1", name: "read_file", arguments: args } },
      { type: "tool-result", sequence: 3, call: { id: "gw-1", name: "read_file" }, result: "fixture" },
    ];
    const [turn] = reduceConversation(snapshot([user(), assistant, { role: "user", content: [done("provider-1")] }], events));
    expect(turn!.toolCalls).toHaveLength(1);
    expect(turn!.toolCalls[0]).toMatchObject({ isRunning: false, queued: false });
  });

  it("out-of-order finish events settle the right calls and leave the other running", () => {
    const [turn] = reduceTurns([
      { type: "user", sequence: 1, text: "go" },
      { type: "tool-start", sequence: 2, call: { id: "a", name: "bash", arguments: {} } },
      { type: "tool-start", sequence: 3, call: { id: "b", name: "read_file", arguments: {} } },
      { type: "tool-result", sequence: 4, call: { id: "b", name: "read_file" }, result: "b" },
    ] as never, "working");
    expect(turn!.toolCalls.map(call => [call.id, call.isRunning])).toEqual([["a", true], ["b", false]]);
  });
});

describe("grouping finished calls", () => {
  const call = (id: string, name: string, extra: object = {}) => ({ id, name, arguments: name === "read_file" ? { path: `${id}.ts` } : {}, result: "ok", isRunning: false, ...extra });
  it("folds consecutive finished calls and leaves running, failed and queued calls standing alone", () => {
    const calls = [call("a", "read_file"), call("b", "read_file"), call("c", "read_file"), call("d", "bash", { arguments: { command: "ls" } }), call("e", "read_file", { result: { success: false, error: "no" } }), call("f", "read_file", { result: undefined, isRunning: true }), call("g", "read_file", { result: undefined, queued: true })];
    const items = groupFinishedCalls(calls as never);
    expect(items.map(item => item.type)).toEqual(["group", "call", "call", "call"]);
    expect(items[0]).toMatchObject({ type: "group" });
    expect(items[0]!.type === "group" && items[0]!.calls.map(c => c.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("summarises the top three kinds in first-seen order", () => {
    const calls = [call("a", "read_file"), call("b", "read_file"), call("c", "read_file"), call("d", "bash", { arguments: { command: "ls" } }), call("e", "bash", { arguments: { command: "pwd" } }), call("f", "search_files", { arguments: { query: "x" } }), call("g", "mystery")];
    expect(groupSummary(calls as never)).toBe("Read 3 files, ran 2 commands, and searched once");
    expect(groupSummary(calls.slice(0, 2) as never)).toBe("Read 2 files");
  });
});
