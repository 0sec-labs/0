import { describe, expect, it } from "vitest";
import type { DecisionState, ReducedTurn } from "./transcript";
import { isInertTurn, visibleResolvedDecisions, visibleTurns } from "./transcript-visibility";

const decision = (kind: DecisionState["kind"], approved: boolean | undefined, resolved = true) => ({ id: `${kind}-${approved}`, kind, title: "Use this workspace folder?", resolved, approved }) as DecisionState;
const turn = (extra: Partial<ReducedTurn> = {}): ReducedTurn => ({ id: "t", user: { text: "", sequence: 1 }, assistantText: "", reasoningText: "", toolCalls: [], decisions: [], notices: [], isComplete: false, isWorking: false, ...extra });

describe("transcript visibility", () => {
  it("hides allowed workspace-folder decisions but keeps declined ones and other kinds", () => {
    const t = turn({ decisions: [decision("local-scope", true), decision("local-scope", undefined), decision("local-scope", false), decision("tool", true)] });
    expect(visibleResolvedDecisions(t).map(d => d.id)).toEqual(["local-scope-false", "tool-true"]);
  });
  it("drops a setup-only leading turn so the empty state shows", () => {
    const setup = turn({ decisions: [decision("local-scope", true)], notices: ["New mission opened"] });
    expect(isInertTurn(setup)).toBe(true);
    expect(visibleTurns([setup])).toEqual([]);
  });
  it("keeps turns with real content, prompts, declines or pending decisions", () => {
    expect(isInertTurn(turn({ user: { text: "scan", sequence: 1 } }))).toBe(false);
    expect(isInertTurn(turn({ assistantText: "ok" }))).toBe(false);
    expect(isInertTurn(turn({ decisions: [decision("local-scope", false)] }))).toBe(false);
    expect(isInertTurn(turn({ decisions: [decision("local-scope", undefined, false)] }))).toBe(false);
    expect(isInertTurn(turn({ notices: ["Workflow request queued."] }))).toBe(false);
  });
});
