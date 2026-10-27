import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { runNativeAgentLoop } from "./native-loop.js";
import { getToolsForRole, ToolExecutor } from "./tools.js";
import type { NativeRuntime } from "../runtime/types.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("overlaps independent local reads, orders receipts, and waits at mutation barriers", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>(resolve => { releaseFirst = resolve; });
  const finished: string[] = [];
  const names = ["read_file", "list_files", "apply_patch", "search_files"];
  vi.spyOn(ToolExecutor.prototype, "execute").mockImplementation(async call => {
    if (call.name === "read_file") await firstReady;
    if (call.name === "list_files") releaseFirst();
    if (call.name === "apply_patch") expect(finished).toEqual(["list_files", "read_file"]);
    if (call.name === "search_files") expect(finished).toContain("apply_patch");
    finished.push(call.name);
    return { success: true, output: call.name };
  });
  const runtime: NativeRuntime = {
    type: "api",
    isAvailable: async () => true,
    executeNative: async () => ({
      content: names.map((name, index) => ({ type: "tool_use" as const, id: `call-${index}`, name, input: {} })),
      stopReason: "tool_use", durationMs: 0,
    }),
  };
  const receipts: string[][] = [];
  const state = await runNativeAgentLoop({
    config: { role: "discovery", systemPrompt: "test", tools: getToolsForRole("discovery"), maxTurns: 1, target: "https://example.test", scanId: randomUUID() },
    runtime, db: null,
    onTurn: (_turn, _calls, results) => receipts.push(results.map(result => String(result.output))),
  });
  expect(receipts).toEqual([names]);
  const results = state.messages.flatMap(message => message.content).filter(block => block.type === "tool_result");
  expect(results.map(block => block.tool_use_id)).toEqual(names.map((_, index) => `call-${index}`));
}, 10_000);

it("limits execution to four local reads at a time", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  let active = 0;
  let peak = 0;
  let completed = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(ToolExecutor.prototype, "execute").mockImplementation(async call => {
    const index = Number(call.arguments.index);
    if (index === 4) expect(completed).toBe(4);
    peak = Math.max(peak, ++active);
    if (active === 4) release();
    await gate;
    active--;
    completed++;
    return { success: true, output: index };
  });
  const runtime: NativeRuntime = {
    type: "api", isAvailable: async () => true,
    executeNative: async () => ({ content: Array.from({ length: 5 }, (_, index) => ({ type: "tool_use" as const, id: String(index), name: "read_file", input: { index } })), stopReason: "tool_use", durationMs: 0 }),
  };
  await runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "test", tools: getToolsForRole("discovery"), maxTurns: 1, target: "https://example.test", scanId: randomUUID() }, runtime, db: null });
  expect(peak).toBe(4);
  expect(completed).toBe(5);
}, 10_000);

it("drains started reads on executor failure without crossing a mutation barrier", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  let drained = false;
  const calls: string[] = [];
  vi.spyOn(ToolExecutor.prototype, "execute").mockImplementation(async call => {
    calls.push(call.name);
    if (call.name === "read_file") throw new Error("executor failure");
    await new Promise(resolve => setTimeout(resolve, 1));
    drained = true;
    return { success: true, output: call.name };
  });
  const runtime: NativeRuntime = {
    type: "api", isAvailable: async () => true,
    executeNative: async () => ({ content: ["read_file", "list_files", "apply_patch"].map((name, index) => ({ type: "tool_use" as const, id: String(index), name, input: {} })), stopReason: "tool_use", durationMs: 0 }),
  };
  await expect(runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "test", tools: getToolsForRole("discovery"), maxTurns: 1, target: "https://example.test", scanId: randomUUID() }, runtime, db: null })).rejects.toThrow("executor failure");
  expect(drained).toBe(true);
  expect(calls).toEqual(["read_file", "list_files"]);
});
