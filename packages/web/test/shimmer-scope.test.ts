import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnTimeline } from "../src/console/turn-timeline";
import { ToolActivity } from "../src/console/tool-activity";
import type { ReducedTurn } from "../src/console/transcript";

const running = (id: string) => ({ id, name: "bash", arguments: { command: `sleep ${id}` }, isRunning: true });
const finished = (id: string) => ({ id, name: "bash", arguments: { command: `echo ${id}` }, result: "ok", isRunning: false });
const turn = (toolCalls: object[], extra: object = {}): ReducedTurn => ({
  id: "t", user: { text: "go", sequence: 1 }, assistantText: "", reasoningText: "", toolCalls, notices: [], decisions: [],
  isWorking: true, isComplete: false, segments: [{ type: "tools", toolIds: (toolCalls as { id: string }[]).map(c => c.id) }], ...extra,
}) as never;
const active = (html: string) => (html.match(/data-shimmer-active="true"/g) ?? []).length;
const render = (t: ReducedTurn, streaming = true) => renderToStaticMarkup(createElement(TurnTimeline, { turn: t, streaming }));

describe("shimmer scope", () => {
  it("shimmers only the newest running call even when several are marked running", () => {
    const html = render(turn([running("a"), running("b"), running("c")]));
    expect(active(html)).toBe(1);
    expect(html.indexOf('data-shimmer-active')).toBeGreaterThan(html.indexOf("sleep c") - 400);
  });
  it("shimmers the Working label when no row is running", () => {
    expect(active(render(turn([finished("a"), finished("b")])))).toBe(1);
  });
  it("shimmers nothing while waiting on the operator or after the turn finished", () => {
    expect(active(render(turn([running("a")]), false))).toBe(0);
    expect(active(render(turn([finished("a")], { isWorking: false, isComplete: true }), false))).toBe(0);
  });
  it("a streaming reasoning tail owns the shimmer; past Thought rows stay plain", () => {
    const t = turn([finished("a")], { reasoningText: "plan", segments: [{ type: "reasoning", text: "first" }, { type: "tools", toolIds: ["a"] }, { type: "reasoning", text: "now" }] });
    expect(active(render(t))).toBe(1);
  });
  it("a standalone tool list shimmers at most one running row", () => {
    expect(active(renderToStaticMarkup(createElement(ToolActivity, { calls: [running("a"), running("b")] as never })))).toBe(1);
  });
  it("queued calls are not rendered", () => {
    const html = render(turn([finished("a"), { ...running("z"), isRunning: false, queued: true }]));
    expect(html).not.toContain("sleep z");
  });
});
