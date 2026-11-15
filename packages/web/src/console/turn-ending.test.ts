import { describe, expect, it } from "vitest";
import type { DesktopConsoleEvent } from "@0/engine/shared";
import { reduceTurns } from "./transcript";
import { runFeedback } from "./run-feedback";
import { TURN_ENDING_ACTIONS, TURN_ENDING_TEXT, turnEnding } from "./turn-ending";

const ev = (sequence: number, rest: object) => ({ sequence, occurredAt: "2026-01-01T00:00:00Z", ...rest }) as unknown as DesktopConsoleEvent;
const budget = { tokensUsed: 0, tokenBudget: null, iterations: 1, maxToolIterations: null };
const finish = (sequence: number, rest: object) => ev(sequence, { type: "turn-complete", assistantText: "", budget, ...rest });
const turnFor = (...events: DesktopConsoleEvent[]) => reduceTurns([ev(1, { type: "user", text: "hello?" }), ...events], "ready")[0]!;

describe("a turn that ended without a visible answer", () => {
  it("(a) empty completion is no reply", () => {
    expect(turnEnding(turnFor(finish(2, { stopReason: "end_turn" })))).toBe("no_reply");
  });
  it("(b) reasoning only is no reply, and the reasoning is kept", () => {
    const turn = turnFor(ev(2, { type: "reasoning-delta", text: "Thinking about it." }), finish(3, { stopReason: "end_turn" }));
    expect(turnEnding(turn)).toBe("no_reply");
    expect(turn.reasoningText).toBe("Thinking about it.");
    expect(turn.segments?.some((segment) => segment.type === "reasoning")).toBe(true);
  });
  it("(c) a length stop keeps its partial text and offers Continue, not Retry", () => {
    const turn = turnFor(ev(2, { type: "assistant-delta", text: "Partial answ" }), finish(3, { stopReason: "output_cap", assistantText: "Partial answ" }));
    expect(turnEnding(turn)).toBe("truncated");
    expect(turn.assistantText).toBe("Partial answ");
    expect(TURN_ENDING_ACTIONS.truncated).toEqual({ retry: false, continue: true, switchModel: false });
  });
  it("(d) a content filter is blocked by the provider", () => {
    const turn = turnFor(finish(2, { stopReason: "error", error: "OpenAI-compatible API error: Provider finish_reason: content_filter" }));
    expect(turnEnding(turn)).toBe("filtered");
    expect(TURN_ENDING_TEXT.filtered).toBe("The provider blocked this reply.");
  });
  it("(e) tool calls that all failed, then nothing, is no reply with the failed work kept", () => {
    const turn = turnFor(
      ev(2, { type: "tool-start", call: { id: "t1", name: "read_file", arguments: {} } }),
      ev(3, { type: "tool-result", call: { id: "t1", name: "read_file" }, result: { success: false, error: "Invalid arguments" } }),
      finish(4, { stopReason: "end_turn" }),
    );
    expect(turnEnding(turn)).toBe("no_reply");
    expect(turn.toolCalls).toHaveLength(1);
  });
  it("a silent finish after a tool that worked is finished work, not a missing reply", () => {
    const turn = turnFor(
      ev(2, { type: "tool-start", call: { id: "t1", name: "write_file", arguments: {} } }),
      ev(3, { type: "tool-result", call: { id: "t1", name: "write_file" }, result: { success: true, output: "ok" } }),
      finish(4, { stopReason: "end_turn" }),
    );
    expect(turnEnding(turn)).toBeUndefined();
  });
  it("(f) a connection closed before any token is a dropped connection", () => {
    const turn = turnFor(finish(2, { stopReason: "error", error: "OpenAI-compatible API error: terminated: other side closed (UND_ERR_SOCKET)" }));
    expect(turnEnding(turn)).toBe("disconnected");
    expect(TURN_ENDING_TEXT.disconnected).toBe("The connection dropped before the model answered.");
  });
  it("(g) HTTP 200 with no choices is no reply", () => {
    const turn = turnFor(finish(2, { stopReason: "error", error: "OpenAI-compatible API error: Stream ended without finish_reason" }));
    expect(turnEnding(turn)).toBe("no_reply");
  });
  it("is silent while the turn runs, after a stop, and for a normal answer", () => {
    expect(turnEnding(reduceTurns([ev(1, { type: "user", text: "hi" })], "working")[0]!)).toBeUndefined();
    expect(turnEnding(turnFor(finish(2, { stopReason: "cancelled" })))).toBeUndefined();
    expect(turnEnding(turnFor(ev(2, { type: "assistant-delta", text: "Hi." }), finish(3, { stopReason: "end_turn", assistantText: "Hi." })))).toBeUndefined();
  });
  it("names the ending on the run line instead of reporting a clean finish", () => {
    const snapshot = { session: { status: "ready" }, pendingDecisions: [] } as never;
    expect(runFeedback(snapshot, turnFor(finish(2, { stopReason: "end_turn" })))).toEqual({ label: "No reply from the model", active: false });
    expect(runFeedback(snapshot, turnFor(ev(2, { type: "assistant-delta", text: "ok" }), finish(3, { stopReason: "end_turn", assistantText: "ok" })))?.label).toBe("Response complete");
  });
});
