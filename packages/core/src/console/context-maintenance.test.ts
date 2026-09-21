import { afterEach, describe, expect, it, vi } from "vitest";
import * as mailbox from "../hub/mailbox.js";
import { ToolExecutor } from "../agent/tools.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import { contextOverflow, estimatePromptTokens, maintainContext, SUMMARY_MARKER } from "./context-maintenance.js";
import { createConsoleSession, DEFAULT_MAX_TOOL_ITERATIONS, type ConsoleCompactionEvent, type ConsoleSessionConfig } from "./turn-engine.js";

const text = (text: string, role: "user" | "assistant" = "user"): NativeMessage => ({ role, content: [{ type: "text", text }] });
const end = (value = "done"): NativeRuntimeResult => ({ content: text(value).content, stopReason: "end_turn", durationMs: 0 });
const summary = "Completed the earlier checks. Preserve the original goal and latest constraints. Continue from the recorded tool results.";
const call = (id: string): NativeRuntimeResult => ({ content: [{ type: "tool_use", id, name: "payload_lookup", input: {} }], stopReason: "tool_use", durationMs: 0 });
const pair = (id: string, size: number): NativeMessage[] => [
  { role: "assistant", content: call(id).content },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(size) }] },
];
const seed = () => [text("ORIGINAL TASK"), ...Array.from({ length: 8 }, (_, i) => pair(`old-${i}`, 12_000)).flat()];
function paired(messages: NativeMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) for (const block of message.content) {
    if (block.type === "tool_use") { expect(pending.has(block.id)).toBe(false); pending.add(block.id); }
    if (block.type === "tool_result") expect(pending.delete(block.tool_use_id)).toBe(true);
  }
  expect(pending.size).toBe(0);
}
function runtime(executeNative: NativeRuntime["executeNative"]): NativeRuntime {
  return { type: "api", isAvailable: async () => true, executeNative };
}
function session(rt: NativeRuntime, extra: Partial<ConsoleSessionConfig> = {}) {
  return createConsoleSession({ runtime: rt, refineObjective: false, allowModelSelfExtension: false,
    systemPrompt: "system", tools: [{ name: "payload_lookup", description: "fake tool", parameters: {} }],
    contextWindowTokens: 20_000, compaction: { enabled: true, thresholdFraction: 0.8 }, ...extra });
}
afterEach(() => vi.restoreAllMocks());

describe("console continuation maintenance", () => {
  it.each(["reported", "absent", "stale"])("compacts repeatedly in one turn from reduced baselines with %s usage", async (usageMode) => {
    const execute = vi.spyOn(ToolExecutor.prototype, "execute").mockResolvedValue({ success: true, output: "x".repeat(28_000) });
    const events: ConsoleCompactionEvent[] = [];
    let planners = 0, summaries = 0;
    const rt = runtime(async (system, messages, tools) => {
      if (!tools.length) { summaries++; return end(summary); }
      paired(messages);
      expect(JSON.stringify(messages)).toContain("LATEST INSTRUCTION");
      return { ...(++planners <= 12 ? call(`call-${planners}`) : end()),
        ...(usageMode === "absent" ? {} : { usage: { inputTokens: usageMode === "stale" ? 1 : estimatePromptTokens(system, messages, tools), outputTokens: 20 } }) };
    });
    const s = session(rt);
    const result = await s.send("LATEST INSTRUCTION", { onCompaction: (event) => events.push(event) });
    expect(result.stopReason).toBe("end_turn");
    expect(execute).toHaveBeenCalledTimes(12);
    const reductions = events.filter((event) => !event.degraded);
    expect(reductions.length).toBeGreaterThanOrEqual(2);
    expect(summaries).toBeLessThanOrEqual(24);
    for (const event of reductions) expect(event.tokensAfter).toBeLessThan(event.tokensBefore);
    paired(s.messages);
    await s.cleanup();
  });

  it("re-arms below the old pre-compaction 90k baseline after regrowth", async () => {
    const events: ConsoleCompactionEvent[] = [];
    const rt = runtime(async (_system, _messages, tools) => tools.length
      ? { ...end(), usage: { inputTokens: 90_000, outputTokens: 1 } } : end(summary));
    const s = session(rt, { contextWindowTokens: 100_000, initialMessages: seed() });
    await s.send("one");
    await s.send("two", { onCompaction: (e) => events.push(e) });
    await s.send("three", { onCompaction: (e) => events.push(e) });
    expect(events.filter((e) => !e.degraded)).toHaveLength(2);
    expect(events[1]!.tokensBefore).toBeLessThan(105_000);
    await s.cleanup();
  });

  it.each([false, true])("maintains giant initial/resumed history before first planner (checkpoint=%s)", async (checkpoint) => {
    const calls: string[] = [];
    const rt = runtime(async (_system, messages, tools) => {
      calls.push(tools.length ? "planner" : "summary");
      if (tools.length) { paired(messages); expect(JSON.stringify(messages)).toContain("new constraint"); }
      return end(tools.length ? "done" : summary);
    });
    let s = session(rt, { initialMessages: seed() });
    if (checkpoint) {
      await s.ready;
      const cp = s.exportCheckpoint();
      await s.cleanup();
      s = session(rt, { initialCheckpoint: cp });
    }
    expect((await s.send("new constraint")).stopReason).toBe("end_turn");
    expect(calls[0]).toBe("summary");
    expect(JSON.stringify(s.messages)).toContain("ORIGINAL TASK");
    await s.cleanup();
  });

  it("sizes pending background output before the first request and keeps operator instructions separate", async () => {
    vi.spyOn(mailbox, "drainInbox").mockReturnValue(Array.from({ length: 8 }, (_, i) => ({
      id: `message-${i}`, from: "peer", to: "console", body: "p".repeat(8000), ts: i,
    })));
    const calls: string[] = [];
    const rt = runtime(async (_system, messages, tools) => {
      calls.push(tools.length ? "planner" : "summary");
      if (tools.length) expect(messages).toContainEqual(text("LATEST OPERATOR CONSTRAINT"));
      return end(tools.length ? "done" : summary);
    });
    const s = session(rt, { agentMessaging: { projectPath: "/synthetic", selfId: "console" } });
    expect((await s.send("LATEST OPERATOR CONSTRAINT")).stopReason).toBe("end_turn");
    expect(calls[0]).toBe("summary");
    await s.cleanup();
  });

  it.each(["thrown", "structured", "object"])("recovers %s overflow with a huge recent output and no duplicate tool execution", async (kind) => {
    const execute = vi.spyOn(ToolExecutor.prototype, "execute").mockResolvedValue({ success: true, output: "x".repeat(150_000) });
    let planners = 0, summaries = 0;
    const rt = runtime(async (_system, messages, tools) => {
      if (!tools.length) { summaries++; return end(summary); }
      paired(messages);
      if (++planners === 1) return call("once");
      const block = messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
      if (block?.type === "tool_result" && block.content.length > 4500) {
        if (kind === "thrown") throw new Error("maximum context length exceeded");
        if (kind === "object") throw { code: "context_length_exceeded", message: "request rejected" };
        return { ...end(), stopReason: "error", error: "context_length_exceeded" };
      }
      expect(block?.type).toBe("tool_result");
      expect(JSON.stringify(messages)).toContain("do not repeat");
      return end();
    });
    const s = session(rt, { compaction: { enabled: false, thresholdFraction: 0.8 } });
    const result = await s.send("do not repeat");
    expect(result.stopReason).toBe("end_turn");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(summaries).toBe(2);
    expect(planners).toBe(4);
    paired(s.messages);
    await s.cleanup();
  });

  it("tries narrower tails when <=13 messages cannot shrink with ten retained", async () => {
    let planners = 0, summaries = 0;
    const rt = runtime(async (_system, messages, tools) => {
      if (!tools.length) { summaries++; return end(summary); }
      planners++;
      return estimatePromptTokens("", messages) > 1500
        ? { ...end(), stopReason: "error", error: "prompt too long" } : end();
    });
    const s = session(rt, { initialMessages: [text("TASK"), text("old".repeat(5000), "assistant"), text("older request"), text("ok", "assistant")], compaction: { enabled: false, thresholdFraction: 0.8 } });
    expect((await s.send("LATEST MUST SURVIVE")).stopReason).toBe("end_turn");
    expect(planners).toBe(2);
    expect(summaries).toBe(1);
    expect(JSON.stringify(s.messages)).toContain("LATEST MUST SURVIVE");
    await s.cleanup();
  });

  it("never applies a late summary or restarts after cancellation", async () => {
    const abort = new AbortController();
    let finish!: (result: NativeRuntimeResult) => void;
    let started!: () => void;
    const summaryStarted = new Promise<void>((resolve) => { started = resolve; });
    let planners = 0;
    const rt = runtime(async (_system, _messages, tools, _callbacks, signal) => {
      if (tools.length) { planners++; return end(); }
      expect(signal).toBe(abort.signal);
      started();
      return new Promise<NativeRuntimeResult>((resolve) => { finish = resolve; });
    });
    const s = session(rt, { initialMessages: seed() });
    const sending = s.send("LATEST", undefined, { signal: abort.signal });
    await summaryStarted;
    const before = structuredClone(s.messages);
    abort.abort();
    finish(end(summary));
    expect((await sending).stopReason).toBe("cancelled");
    expect(s.messages).toEqual(before);
    expect(planners).toBe(0);
    await s.cleanup();
  });

  it("bounds irreducible overflow and keeps oversized latest instructions verbatim", async () => {
    let calls = 0;
    const s = session(runtime(async () => { calls++; return { ...end(), stopReason: "error", error: "context window exceeded" }; }));
    const instruction = "LATEST".repeat(30_000);
    expect((await s.send(instruction)).stopReason).toBe("error");
    expect(calls).toBe(1);
    expect(s.messages).toEqual([text(instruction)]);
    await s.cleanup();
  });

  it("bounds non-reducing summaries and suppresses repetition without growth", async () => {
    let summaries = 0;
    const rt = runtime(async (_system, _messages, tools) => {
      if (!tools.length) { summaries++; return end("summary".repeat(100_000)); }
      return end();
    });
    const s = session(rt, { initialMessages: seed() });
    await s.send("one");
    const first = summaries;
    await s.send("two");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(3);
    expect(summaries).toBe(first);
    await s.cleanup();
  });

  it.each(["quota exceeded", "rate_limit_exceeded", "authentication failed", "server unavailable"])("does not recover or retry %s", async (error) => {
    let calls = 0;
    const s = session(runtime(async () => { calls++; throw new Error(error); }), { compaction: { enabled: false, thresholdFraction: 0.8 }, initialMessages: seed() });
    expect((await s.send("go")).stopReason).toBe("error");
    expect(calls).toBe(1);
    await s.cleanup();
  });

  it.each([401, 403, 429, 500])("retains thrown SDK status %s when the message alone resembles overflow", async (status) => {
    const rt = runtime(vi.fn(async () => { throw Object.assign(new Error("context length exceeded"), { status }); }));
    const s = session(rt, { initialMessages: seed(), compaction: { enabled: false, thresholdFraction: 0.8 } });
    expect((await s.send("go")).stopReason).toBe("error");
    expect(rt.executeNative).toHaveBeenCalledTimes(1);
    await s.cleanup();
  });

  it("does not bypass quota failures from summarization", async () => {
    let calls = 0;
    const s = session(runtime(async () => { calls++; return { ...end(), stopReason: "error", error: "quota exceeded" }; }), { initialMessages: seed() });
    expect((await s.send("go")).error).toContain("quota");
    expect(calls).toBe(1);
    await s.cleanup();
  });

  it("respects finite budgets before maintenance and counts maintenance spend before planning", async () => {
    const rt = runtime(vi.fn(async () => ({ ...end(summary), usage: { inputTokens: 45_000, outputTokens: 1000 } })));
    const s = session(rt, { initialMessages: seed(), maxTurnTokens: 40_000 });
    const result = await s.send("go");
    expect(result.stopReason).toBe("max_turn_tokens");
    expect(result.budget.tokensUsed).toBe(46_000);
    expect(rt.executeNative).toHaveBeenCalledTimes(1);
    await s.cleanup();
    const small = session(rt, { initialMessages: seed(), maxTurnTokens: 1 });
    expect((await small.send("go")).stopReason).toBe("max_turn_tokens");
    expect(rt.executeNative).toHaveBeenCalledTimes(1);
    await small.cleanup();
  });

  it.each([{ model: "unknown" }, { provider: "changed" }, { contextWindowTokens: null }])("clears stale occupancy/window on reconfiguration %j", async (selection) => {
    let summaries = 0;
    const rt = runtime(async (_system, _messages, tools) => {
      if (!tools.length) { summaries++; return end(summary); }
      return { ...end(), usage: { inputTokens: 90_000, outputTokens: 1 } };
    });
    const s = session(rt, { initialMessages: seed(), contextWindowTokens: 100_000 });
    await s.send("one");
    s.reconfigureRuntime(selection);
    await s.send("two");
    expect(summaries).toBe(0);
    s.reconfigureRuntime({ model: "small-known", contextWindowTokens: 10_000 });
    await s.send("three");
    expect(summaries).toBeGreaterThan(0);
    await s.cleanup();
  });

  it("reserves output headroom with a 100% configured threshold", async () => {
    let summaries = 0;
    const rt = runtime(async (_system, _messages, tools) => {
      if (!tools.length) { summaries++; return end(summary); }
      return { ...end(), usage: { inputTokens: 90_000, outputTokens: 1 } };
    });
    const s = session(rt, { initialMessages: seed(), contextWindowTokens: 95_000, compaction: { enabled: true, thresholdFraction: 1 } });
    await s.send("one");
    await s.send("two");
    expect(summaries).toBeGreaterThan(0);
    await s.cleanup();
  });

  it("leaves server-side compaction ownership intact even on overflow", async () => {
    const rt = Object.assign(runtime(vi.fn(async () => ({ ...end(), stopReason: "error" as const, error: "context_length_exceeded" }))), { compactionTokens: 1000 });
    const s = session(rt, { initialMessages: seed() });
    const before = structuredClone(s.messages);
    expect((await s.send("go")).stopReason).toBe("error");
    expect(rt.executeNative).toHaveBeenCalledTimes(1);
    expect(s.messages).toEqual([...before, text("go")]);
    await s.cleanup();
  });

  it("exports the shared 100-round backstop", () => expect(DEFAULT_MAX_TOOL_ITERATIONS).toBe(100));
});

describe("maintenance exchange invariants", () => {
  it("retains paired integrity and previous summary on lossy recovery", async () => {
    const original: NativeMessage[] = [text("TASK"), text(`${SUMMARY_MARKER}\nPRIOR DECISIONS`), ...pair("a", 6000), ...pair("b", 6000), text("LATEST")];
    const result = await maintainContext({ messages: original, runtime: runtime(async () => end("short")), instruction: "summarize", preserveTail: 0,
      allowLossy: true, remainingTokens: Infinity, onUsage: () => {} });
    paired(result.messages);
    expect(result.degraded).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("PRIOR DECISIONS");
    expect(result.messages).toContainEqual(text("LATEST"));
    expect(original).toHaveLength(7);
  });

  it("keeps multi-tool exchanges whole at the tail and preserves operator text before pending messages", async () => {
    const operator = text("LATEST OPERATOR CONSTRAINT");
    const multi: NativeMessage[] = [
      { role: "assistant", content: [...call("a").content, ...call("b").content] },
      pair("a", 100)[1]!, pair("b", 100)[1]!,
    ];
    const original = [text("TASK"), operator, text("old".repeat(3000), "assistant"), ...multi, text("PENDING BACKGROUND OUTPUT")];
    const result = await maintainContext({ messages: original, latestUserMessage: operator, runtime: runtime(async () => end(summary)), instruction: "summarize", preserveTail: 2,
      allowLossy: false, remainingTokens: Infinity, onUsage: () => {} });
    paired(result.messages);
    expect(result.messages).toContainEqual(operator);
    for (const message of multi) expect(result.messages).toContainEqual(message);
    expect(result.messages).toContainEqual(original.at(-1));
  });

  it("counts streamed summarizer usage exactly once", async () => {
    const usage = vi.fn();
    await maintainContext({ messages: seed(), runtime: runtime(async (_system, _messages, _tools, callbacks) => {
      callbacks?.onUsage?.({ inputTokens: 150, outputTokens: 25 });
      return { ...end(summary), usage: { inputTokens: 200, outputTokens: 30 } };
    }), instruction: "summarize", preserveTail: 2, allowLossy: false, remainingTokens: Infinity, onUsage: usage });
    expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 200, outputTokens: 30 });
  });

  it("does not rewrite an unpaired boundary", async () => {
    const original = [text("TASK"), { role: "assistant" as const, content: call("pending").content }];
    const rt = runtime(vi.fn());
    expect((await maintainContext({ messages: original, runtime: rt, instruction: "summarize", preserveTail: 0,
      allowLossy: true, remainingTokens: Infinity, onUsage: () => {} })).messages).toBe(original);
    expect(rt.executeNative).not.toHaveBeenCalled();
  });

  it("excludes quota/rate/auth failures mentioning context from overflow", () => {
    for (const error of ["quota: too many tokens", "429: context window exceeded", "authentication: input too large", "rate_limit_exceeded: maximum context"]) expect(contextOverflow(error)).toBe(false);
  });
});
