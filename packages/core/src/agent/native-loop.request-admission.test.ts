import { afterEach, expect, it, vi } from "vitest";
import { runNativeAgentLoop, compactMessagesWithLLM } from "./native-loop.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
afterEach(() => vi.unstubAllEnvs());
it("compacts a locally rejected unsent request before missing-usage checks, meters summary, and does not repeat tools", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  const usage = { inputTokens: 10, outputTokens: 2 };
  let planners = 0, summaries = 0;
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true,
    executeNative: async (system): Promise<NativeRuntimeResult> => {
      if (system.startsWith("You are a concise technical summarizer")) {
        summaries++; return { content: [{ type: "text", text: "Completed three recorded planning steps. Preserve tenant isolation and continue from the current investigation. ".repeat(3) }], stopReason: "end_turn", durationMs: 0, usage };
      }
      planners++;
      if (planners <= 3) return { content: [{ type: "tool_use", id: `plan${planners}`, name: "update_todos", input: { todos: [{ content: `Step ${planners}`, status: "pending" }] } }], stopReason: "tool_use", durationMs: 0, usage };
      if (planners === 4) return { content: [], stopReason: "error", durationMs: 0, error: "LOCAL_REQUEST_ADMISSION_LIMIT: input exceeds gateway byte limit before dispatch" };
      return { content: [{ type: "tool_use", id: "done", name: "done", input: { summary: "Finished after bounded compaction" } }], stopReason: "tool_use", durationMs: 0, usage };
    } };
  const events: string[] = [];
  const state = await runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "Investigate", tools: [], maxTurns: 8,
    target: "https://example.test", scanId: "local-admission-control", requirePricedUsage: true }, runtime, db: null,
    onEvent: event => events.push(event) });
  expect(state.done).toBe(true); expect(state.errorExit).toBeUndefined(); expect(summaries).toBe(1); expect(planners).toBe(5);
  expect(state.totalUsage.inputTokens).toBe(50); expect(events).toContain("context_compacted");
});
it("retains recent native reasoning and tool-call ordering verbatim during the reused compactor", async () => {
  const raw = { provider: "openai", model: "auto", wireApi: "responses" as const,
    output: [{ type: "reasoning", encrypted_content: "opaque-fixture" }, { type: "function_call", call_id: "last", name: "read_file", arguments: "{}" }] };
  const tail: NativeMessage[] = [{ role: "assistant", content: [{ type: "tool_use", id: "last", name: "read_file", input: {} }], providerRaw: raw },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "last", content: "Recorded source evidence" }] }];
  const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Initial scope" }] },
    ...Array.from({ length: 6 }, (_, i): NativeMessage => ({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: "Earlier observation" }] })), ...tail];
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async () => ({ content: [{ type: "text", text: "Summary of recorded observations. ".repeat(8) }], stopReason: "end_turn", durationMs: 0 }) };
  const c = await compactMessagesWithLLM(messages, runtime, "Task", { preserveTailCount: 2 });
  expect(c.messages[0]).toEqual(messages[0]); expect(c.messages.slice(-2)).toEqual(tail); expect(c.messages.at(-2)?.providerRaw).toEqual(raw);
});
it("refuses fallback after unknown or unpriced summary outcomes", async () => {
  const messages: NativeMessage[] = Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "Evidence" }] }));
  for (const response of [
    { content: [], stopReason: "error", durationMs: 0, error: "Request outcome may be unknown. Automatic replay is disabled" },
    { content: [{ type: "text", text: "A useful summary. ".repeat(5) }], stopReason: "end_turn", durationMs: 0 },
  ] satisfies NativeRuntimeResult[]) {
    const executeNative = vi.fn().mockResolvedValue(response);
    await expect(compactMessagesWithLLM(messages, { type: "api", isAvailable: async () => true, executeNative }, "Task", {
      preserveTailCount: 2, requireSummaryReceipt: true,
    })).rejects.toThrow();
    expect(executeNative).toHaveBeenCalledTimes(1);
  }
});
it("terminates an unsendable opening request without inventing unpriced provider usage", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  const { ScanCostLedger } = await import("./cost-ledger.js");
  const ledger = new ScanCostLedger();
  const executeNative = vi.fn().mockResolvedValue({ content: [], stopReason: "error", durationMs: 0,
    error: "LOCAL_REQUEST_ADMISSION_LIMIT: input exceeds gateway byte limit before dispatch" });
  const state = await runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "Task", tools: [], maxTurns: 8,
    target: "https://example.test", scanId: "unsendable-opening", requirePricedUsage: true, costLedger: ledger },
    runtime: { type: "api", isAvailable: async () => true, executeNative }, db: null });
  expect(executeNative).toHaveBeenCalledTimes(1); expect(state.done).toBe(false);
  expect(ledger.hasUnpricedUsage()).toBe(false); expect(state.totalUsage.inputTokens).toBe(0);
});
it("keeps a native call and its result when an extra user warning follows", async () => {
  const raw = { provider: "openai", model: "auto", wireApi: "responses" as const,
    output: [{ type: "reasoning", encrypted_content: "retain-verbatim" }, { type: "function_call", call_id: "recent", name: "read_file", arguments: "{}" }] };
  const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Initial scope" }] },
    ...Array.from({ length: 4 }, (_, i): NativeMessage => ({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: "Old recorded observation" }] })),
    { role: "assistant", providerRaw: raw, content: [{ type: "tool_use", id: "recent", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "recent", content: "Exact latest source result" }] },
    { role: "user", content: [{ type: "text", text: "Keep within the approved budget" }] }];
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async () => ({
    content: [{ type: "text", text: "A successful metered source summary. ".repeat(4) }], stopReason: "end_turn", durationMs: 0, usage: { inputTokens: 20, outputTokens: 10 } }) };
  const c = await compactMessagesWithLLM(messages, runtime, "Task", { preserveTailCount: 2, requireSummaryReceipt: true });
  expect(c.messages.at(-2)?.providerRaw).toEqual(raw);
  expect(c.messages.at(-1)?.content).toEqual([...messages.at(-2)!.content, ...messages.at(-1)!.content]);
});
it("marks unknown dispatched summaries unpriced, but not known locally rejected summaries, without planner replay", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  const { ScanCostLedger } = await import("./cost-ledger.js");
  for (const [error, unpriced] of [
    ["Request outcome may be unknown. Automatic replay is disabled", true],
    ["LOCAL_REQUEST_ADMISSION_LIMIT: summary too large before dispatch", false],
    ["LOCAL_REQUEST_ADMISSION_UNAVAILABLE: catalog unavailable; no inference request sent", false],
  ] as const) {
    let planners = 0, summaries = 0; const ledger = new ScanCostLedger();
    const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async system => {
      if (system.startsWith("You are a concise technical summarizer")) { summaries++; return { content: [], stopReason: "error", durationMs: 0, error }; }
      planners++;
      if (planners <= 3) return { content: [{ type: "tool_use", id: `step${planners}`, name: "update_todos", input: { todos: [{ content: "Recorded plan", status: "pending" }] } }],
        stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 10, outputTokens: 2 } };
      return { content: [], stopReason: "error", durationMs: 0, error: "LOCAL_REQUEST_ADMISSION_LIMIT: planner input too large before dispatch" };
    } };
    const state = await runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "Task", tools: [], maxTurns: 8, target: "https://example.test",
      scanId: "summary-ledger-control", requirePricedUsage: true, costLedger: ledger }, runtime, db: null });
    expect(planners).toBe(4); expect(summaries).toBe(1); expect(state.done).toBe(false); expect(ledger.hasUnpricedUsage()).toBe(unpriced);
  }
});
it("marks a cancelled dispatched summary uncertain without rewriting history or replay", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  const { ScanCostLedger } = await import("./cost-ledger.js"); const ledger = new ScanCostLedger();
  const controller = new AbortController(); let planners = 0, summaries = 0; let before: NativeMessage[] = [];
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async (system, messages) => {
    if (system.startsWith("You are a concise technical summarizer")) {
      summaries++; controller.abort(); return { content: [], stopReason: "error", cancelled: true, durationMs: 0, error: "Context summary cancelled without receipt" };
    }
    planners++; before = structuredClone(messages);
    if (planners <= 3) return { content: [{ type: "tool_use", id: `step${planners}`, name: "update_todos", input: { todos: [{ content: "Recorded plan", status: "pending" }] } }],
      stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 10, outputTokens: 2 } };
    return { content: [], stopReason: "error", durationMs: 0, error: "LOCAL_REQUEST_ADMISSION_LIMIT: planner too large before dispatch" };
  } };
  const state = await runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "Task", tools: [], maxTurns: 8,
    target: "https://example.test", scanId: "summary-cancelled-control", requirePricedUsage: true, costLedger: ledger },
    runtime, db: null, signal: controller.signal });
  expect(planners).toBe(4); expect(summaries).toBe(1); expect(ledger.hasUnpricedUsage()).toBe(true);
  expect(state.messages).toEqual(before); expect(state.done).toBe(false);
});
