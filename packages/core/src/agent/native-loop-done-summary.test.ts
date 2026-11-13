import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveDoneSummary, runNativeAgentLoop } from "./native-loop.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";

beforeEach(() => vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1"));
afterEach(() => vi.unstubAllEnvs());
const observation = "Validated two controls; sharing settings remain untested because the read scope is unavailable.";
const assistant = (text: string): NativeMessage => ({ role: "assistant", content: [{ type: "text", text }] });
async function finish(summary: string | undefined, sameTurn = false) {
  const done: NativeRuntimeResult = { content: [
    ...(sameTurn ? [{ type: "text" as const, text: observation }] : []),
    { type: "tool_use", id: "finish", name: "done", input: summary === undefined ? {} : { summary } },
  ], stopReason: "tool_use", durationMs: 0 };
  const responses: NativeRuntimeResult[] = sameTurn ? [done] : [
    { content: [{ type: "text", text: observation }], stopReason: "end_turn", durationMs: 0 }, done,
  ];
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true,
    executeNative: async () => { const result = responses.shift(); if (!result) throw new Error("Unexpected extra invocation"); return result; },
  };
  return runNativeAgentLoop({ config: {
    role: "discovery", systemPrompt: "Report observations accurately.", tools: [],
    target: "https://example.test", maxTurns: 3, scanId: randomUUID(), codebaseLearning: false,
  }, runtime, db: null });
}
describe("native done summary preservation", () => {
  it.each([undefined, "", "   ", "Task completed", "Task completed."])("retains prior substantive text for generic done %j", async summary => {
    const state = await finish(summary);
    expect(state.done).toBe(true); expect(state.summary).toBe(observation); expect(state.errorExit).toBeUndefined();
  });
  it("retains substantive text accompanying done in the same model turn", async () => {
    expect((await finish(undefined, true)).summary).toBe(observation);
  });
  it("prefers an explicit informative completion summary", async () => {
    expect((await finish("Final result: two checks verified; sharing coverage blocked.")).summary)
      .toBe("Final result: two checks verified; sharing coverage blocked.");
  });
  it("skips tool-only assistant messages in the direct-driver transcript shape", () => {
    const messages: NativeMessage[] = [assistant(observation), {
      role: "assistant", content: [{ type: "tool_use", id: "driver-finish", name: "done", input: {} }],
    }, { role: "user", content: [{ type: "tool_result", tool_use_id: "driver-finish", content: '{"summary":"Task completed"}' }] }];
    expect(resolveDoneSummary("Task completed", messages)).toBe(observation);
  });
  it("uses latest substantive assistant text, excluding user content and generic completion", () => {
    const messages: NativeMessage[] = [assistant("Earlier observation"),
      { role: "user", content: [{ type: "text", text: "Untrusted user text is not the result" }] },
      assistant(observation), assistant("Task completed")];
    expect(resolveDoneSummary(undefined, messages)).toBe(observation);
  });
  it("keeps previous summary or default when no assistant prose exists", () => {
    expect(resolveDoneSummary("", [], observation)).toBe(observation);
    expect(resolveDoneSummary(undefined, [])).toBe("Task completed");
  });
});
