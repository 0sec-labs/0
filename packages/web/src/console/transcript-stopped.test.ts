import { describe, expect, it } from "vitest";
import type { DesktopConsoleEvent } from "@0/engine/shared";
import { reduceTurns } from "./transcript";

const ev = (sequence: number, rest: object) => ({ sequence, occurredAt: "2026-01-01T00:00:00Z", ...rest }) as unknown as DesktopConsoleEvent;

describe("reduceTurns on a stopped turn", () => {
  it("keeps the streamed partial reply when the outcome reports no final text", () => {
    const turns = reduceTurns([
      ev(1, { type: "user", text: "slow" }),
      ev(2, { type: "assistant-delta", text: "word1 " }),
      ev(3, { type: "assistant-delta", text: "word2 " }),
      ev(4, { type: "turn-complete", stopReason: "cancelled", assistantText: "" }),
    ]);
    expect(turns[0]?.assistantText).toBe("word1 word2 ");
    expect(turns[0]?.segments?.some((segment) => segment.type === "assistant" && segment.text.includes("word2"))).toBe(true);
    expect(turns[0]?.stopReason).toBe("cancelled");
  });
  it("still treats an empty final text as authoritative for finished turns", () => {
    const turns = reduceTurns([
      ev(1, { type: "user", text: "q" }),
      ev(2, { type: "assistant-delta", text: "draft" }),
      ev(3, { type: "turn-complete", stopReason: "end_turn", assistantText: "" }),
    ]);
    expect(turns[0]?.assistantText).toBe("");
  });
});
