import { describe, expect, it } from "vitest";
import type { DesktopConsoleEvent } from "@0/engine/shared";
import { reduceTurns } from "./transcript";
import { retryLabel } from "./transcript-actions";

const ev = (sequence: number, rest: object) => ({ sequence, occurredAt: "2026-01-01T00:00:00.000Z", ...rest }) as unknown as DesktopConsoleEvent;
const retry = { reason: "rate_limited", status: 429, delayMs: 12_000, attempt: 1, maxAttempts: 12 };

describe("reduceTurns on a provider retry", () => {
  it("records when the retry resumes and clears it once output arrives", () => {
    const waiting = reduceTurns([ev(1, { type: "user", text: "hi" }), ev(2, { type: "retry", retry })]);
    expect(waiting[0]?.retry).toEqual({ reason: "rate_limited", attempt: 1, maxAttempts: 12, resumeAt: Date.parse("2026-01-01T00:00:00.000Z") + 12_000 });
    const resumed = reduceTurns([ev(1, { type: "user", text: "hi" }), ev(2, { type: "retry", retry }), ev(3, { type: "assistant-delta", text: "ok" })]);
    expect(resumed[0]?.retry).toBeUndefined();
  });
  it("clears the retry when the turn fails", () => {
    const turns = reduceTurns([ev(1, { type: "user", text: "hi" }), ev(2, { type: "retry", retry }), ev(3, { type: "turn-complete", stopReason: "error", assistantText: "", error: "429" })]);
    expect(turns[0]?.retry).toBeUndefined();
  });
});

describe("retryLabel", () => {
  it("counts down to the retry", () => {
    const state = { reason: "rate_limited" as const, resumeAt: 10_000 };
    expect(retryLabel(state, 0)).toBe("Rate limited, retrying in 10s…");
    expect(retryLabel(state, 9_100)).toBe("Rate limited, retrying in 1s…");
    expect(retryLabel(state, 10_000)).toBe("Rate limited, retrying…");
  });
});
