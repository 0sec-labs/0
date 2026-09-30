import { describe, expect, it } from "vitest";
import type { ChatEntry } from "./types.js";
import { replaceSubagentTurn, retainSubagentTurns } from "./subagent-transcript.js";

const assistant = (turn: number, text: string): ChatEntry => ({ id: `worker-t${turn}-a`, kind: "assistant", turn, text });
const tool = (turn: number, index: number): ChatEntry => ({ id: `worker-t${turn}-x${index}`, kind: "tool", turn, text: `tool ${index}` });

describe("worker conversation snapshots", () => {
  it("settles an older turn in place, removes hidden pending controls, and preserves operator messages", () => {
    const operator: ChatEntry = { id: "worker-operator-1", kind: "user", text: "continue", turn: 1 };
    const settled = replaceSubagentTurn([assistant(1, "partial"), tool(1, 4), operator, assistant(2, "later answer")],
      [assistant(1, "complete answer")], "worker", 1, 300);
    expect(settled.map((entry) => entry.text)).toEqual(["complete answer", "continue", "later answer"]);
  });

  it("keeps full prose when the current turn exceeds the old entry-count cap", () => {
    const answer = "Full paragraph.\n".repeat(800);
    const turn = [assistant(2, answer), ...Array.from({ length: 301 }, (_, index) => tool(2, index))];
    const retained = retainSubagentTurns([assistant(1, "old answer"), ...turn], 300);
    expect(retained[0]?.text).toBe(answer);
    expect(retained.map((entry) => entry.text)).toEqual(turn.map((entry) => entry.text));
  });

  it("an empty final snapshot removes stale turn output without deleting unrelated conversation", () => {
    expect(replaceSubagentTurn([assistant(1, "stale"), assistant(2, "retained")], [], "worker", 1, 300)
      .map((entry) => entry.text)).toEqual(["retained"]);
  });
});
