import { describe, expect, it } from "vitest";
import type { ConsoleSessionSnapshot, DesktopConsoleEvent } from "@0/engine/shared";
import { reduceConversation } from "./transcript";

const ev = (sequence: number, rest: object) => ({ sequence, occurredAt: "2026-01-01T00:00:00Z", ...rest }) as unknown as DesktopConsoleEvent;

function snapshot(events: DesktopConsoleEvent[]): ConsoleSessionSnapshot {
  return {
    session: { id: "s", status: "ready" },
    cursor: 9,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hey. What are we looking at?" }],
        providerRaw: { output: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Hey. What are we looking at?" }] },
      },
      { role: "user", content: [{ type: "text", text: "wassup" }] },
      { role: "assistant", content: [{ type: "text", text: "All good." }] },
    ],
    events,
    pendingDecisions: [],
    workers: [],
    queuedMessages: [],
    lastOutcome: null,
  } as unknown as ConsoleSessionSnapshot;
}

/** The turn's closing answer is whatever follows the last reasoning/tool segment; it must not be hidden in the work log. */
function answerOf(turn: ReturnType<typeof reduceConversation>[number]) {
  const segments = turn.segments ?? [];
  const lastWork = segments.findLastIndex((s) => s.type !== "assistant");
  return segments.slice(lastWork + 1).flatMap((s) => (s.type === "assistant" ? [s.text] : []));
}

// The journal is trimmed: turn 1's user event is gone, but its reasoning survives ahead of turn 2.
const later = [
  ev(5, { type: "user", text: "wassup" }),
  ev(6, { type: "assistant-delta", text: "All good." }),
  ev(7, { type: "turn-complete", stopReason: "end_turn", assistantText: "All good." }),
];

describe("first reply with thinking and a trimmed event journal", () => {
  it("keeps the reply as the answer when only the reasoning survives in the journal", () => {
    const turns = reduceConversation(snapshot([ev(3, { type: "reasoning-delta", text: "plan" }), ...later]));
    expect(turns[0].assistantText).toBe("Hey. What are we looking at?");
    expect(answerOf(turns[0])).toEqual(["Hey. What are we looking at?"]);
  });
  it("does the same when the journal also carries the reply deltas", () => {
    const turns = reduceConversation(snapshot([
      ev(3, { type: "reasoning-delta", text: "plan" }),
      ev(4, { type: "assistant-delta", text: "Hey. What are we looking at?" }),
      ...later,
    ]));
    expect(answerOf(turns[0])).toEqual(["Hey. What are we looking at?"]);
  });
});
