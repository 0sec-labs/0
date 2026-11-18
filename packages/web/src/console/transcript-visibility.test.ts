import { describe, expect, it } from "vitest";
import type { DecisionState, ReducedTurn } from "./transcript";
import { isInertTurn, visibleTurns } from "./transcript-visibility";

const decision = (kind: DecisionState["kind"], approved: boolean | undefined, resolved = true) => ({ id: `${kind}-${approved}`, kind, title: "Use this tool?", resolved, approved }) as DecisionState;
const turn = (extra: Partial<ReducedTurn> = {}): ReducedTurn => ({ id: "t", user: { text: "", sequence: 1 }, assistantText: "", reasoningText: "", toolCalls: [], decisions: [], notices: [], isComplete: false, isWorking: false, ...extra });

describe("transcript visibility", () => {
  it("drops a setup-only leading turn so the empty state shows", () => {
    const setup = turn({ notices: ["New thread opened"] });
    expect(isInertTurn(setup)).toBe(true);
    expect(visibleTurns([setup])).toEqual([]);
  });
  it("keeps turns with real content, prompts, declines or pending decisions", () => {
    expect(isInertTurn(turn({ user: { text: "scan", sequence: 1 } }))).toBe(false);
    expect(isInertTurn(turn({ assistantText: "ok" }))).toBe(false);
    expect(isInertTurn(turn({ decisions: [decision("tool", false)] }))).toBe(false);
    expect(isInertTurn(turn({ decisions: [decision("tool", undefined, false)] }))).toBe(false);
    expect(isInertTurn(turn({ notices: ["Workflow request queued."] }))).toBe(false);
  });
});
