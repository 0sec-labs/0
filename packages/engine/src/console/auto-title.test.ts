import { describe, expect, it, vi } from "vitest";
import {
  fallbackConversationTitle,
  firstExchange,
  generateConversationTitle,
  inferTitleSource,
  isDefaultConversationTitle,
  pickTitleModel,
  redactForTitle,
  sanitizeGeneratedTitle,
} from "./auto-title.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";

function reply(text: string, usage = { inputTokens: 120, outputTokens: 8 }): NativeRuntimeResult {
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage };
}

function fakeRuntime(result: () => Promise<NativeRuntimeResult>) {
  const calls: Array<{ system: string; messages: NativeMessage[]; tools: unknown[]; signal?: AbortSignal }> = [];
  const runtime = {
    type: "api" as const,
    isAvailable: async () => true,
    executeNative: vi.fn(async (system: string, messages: NativeMessage[], tools: unknown[], _cb?: unknown, signal?: AbortSignal) => {
      calls.push({ system, messages, tools, signal });
      return result();
    }),
  } as unknown as NativeRuntime;
  return { runtime, calls };
}

describe("title helpers", () => {
  it("classifies default and legacy titles", () => {
    expect(isDefaultConversationTitle("")).toBe(true);
    expect(isDefaultConversationTitle("  New chat ")).toBe(true);
    expect(isDefaultConversationTitle("New mission")).toBe(true);
    expect(isDefaultConversationTitle("wassup")).toBe(false);
    expect(inferTitleSource("Campaign iter 12: probe-auth")).toBe("user");
    expect(inferTitleSource(undefined)).toBe("default");
  });

  it("sanitizes model output to a short, quote-free title", () => {
    expect(sanitizeGeneratedTitle('Title: "Review tenant isolation boundaries today please now."')).toBe("Review tenant isolation boundaries today please");
    expect(sanitizeGeneratedTitle("**Fix login redirect bug**\nextra explanation")).toBe("Fix login redirect bug");
    expect(sanitizeGeneratedTitle("  \n ")).toBeUndefined();
    expect(sanitizeGeneratedTitle("“Schema audit”…")).toBe("Schema audit");
  });

  it("builds a deterministic fallback at a word boundary", () => {
    expect(fallbackConversationTitle("wassup")).toBe("wassup");
    expect(fallbackConversationTitle("Please review the auth flow. Then also the billing code.")).toBe("Please review the auth flow");
    const long = fallbackConversationTitle("Investigate the intermittent authorization failures across every tenant boundary in staging")!;
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith(" ")).toBe(false);
    expect("Investigate the intermittent authorization failures across every tenant boundary in staging".startsWith(long)).toBe(true);
    expect(fallbackConversationTitle("   ")).toBeUndefined();
  });

  it("redacts credential-shaped text", () => {
    const text = redactForTitle("use sk-abcdefghijklmnopqrstuvwxyz123456 and password=hunter2 with Bearer abcdefghijklmnop1234");
    expect(text).not.toContain("sk-abcdef");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abcdefghijklmnop1234");
  });

  it("extracts the first exchange and skips compaction summaries", () => {
    const messages: NativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "[COMPACTED CONVERSATION SUMMARY]\nold" }] },
      { role: "user", content: [{ type: "text", text: "hello there" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ];
    expect(firstExchange(messages)).toEqual({ user: "hello there", assistant: "Hi!" });
    expect(firstExchange([])).toEqual({ user: "", assistant: "" });
  });
});

describe("generateConversationTitle", () => {
  it("uses one tool-less model call and returns usage", async () => {
    const { runtime, calls } = fakeRuntime(async () => reply('"Tenant isolation review."'));
    const result = await generateConversationTitle({ runtime, userText: "Review tenant isolation", assistantText: "Sure, starting." });
    expect(result).toMatchObject({ title: "Tenant isolation review", source: "model", usage: { inputTokens: 120, outputTokens: 8 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tools).toEqual([]);
  });

  it("sends only the first message and the head of the assistant reply, redacted", async () => {
    const { runtime, calls } = fakeRuntime(async () => reply("Short title"));
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    await generateConversationTitle({ runtime, userText: `${secret} ${"u".repeat(5000)}`, assistantText: `${"a".repeat(600)}TAILMARKER` });
    const sent = JSON.stringify(calls[0]!.messages);
    expect(sent).not.toContain(secret);
    expect(sent).not.toContain("TAILMARKER");
    expect(sent.length).toBeLessThan(2000);
  });

  it("falls back deterministically when the call fails", async () => {
    const { runtime } = fakeRuntime(async () => { throw new Error("boom"); });
    await expect(generateConversationTitle({ runtime, userText: "Audit the billing service. Thanks" })).resolves.toEqual({ title: "Audit the billing service.".replace(/\.$/, ""), source: "fallback" });
  });

  it("falls back when the model reports an error stop", async () => {
    const { runtime } = fakeRuntime(async () => ({ content: [], stopReason: "error", error: "nope" }));
    expect((await generateConversationTitle({ runtime, userText: "wassup" }))?.source).toBe("fallback");
  });

  it("falls back after the timeout without waiting for a hung provider", async () => {
    const { runtime, calls } = fakeRuntime(() => new Promise<NativeRuntimeResult>(() => undefined));
    const started = Date.now();
    const result = await generateConversationTitle({ runtime, userText: "Check the CSP headers", timeoutMs: 30 });
    expect(result).toEqual({ title: "Check the CSP headers", source: "fallback" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("uses the deterministic title when no runtime is available", async () => {
    await expect(generateConversationTitle({ runtime: null, userText: "hi" })).resolves.toEqual({ title: "hi", source: "fallback" });
    await expect(generateConversationTitle({ runtime: null, userText: "  " })).resolves.toBeUndefined();
  });

  it("prefers the cheapest approved model via a disposable fork", async () => {
    const fork = fakeRuntime(async () => reply("Cheap title"));
    const setReasoningEffort = vi.fn();
    const forked = Object.assign(fork.runtime, { setReasoningEffort });
    const parent = Object.assign(fakeRuntime(async () => reply("Expensive title")).runtime, {
      resolvedModel: () => "claude-opus-4-5",
      modelSelection: () => ({ agentModels: { explore: "claude-haiku-4-5" }, singleModel: false }),
      forkForSubagent: vi.fn(async () => forked),
    });
    expect(pickTitleModel(parent as never)).toBe("claude-haiku-4-5");
    const result = await generateConversationTitle({ runtime: parent, userText: "Map the attack surface" });
    expect(result?.title).toBe("Cheap title");
    expect(parent.forkForSubagent).toHaveBeenCalledWith(8000, { model: "claude-haiku-4-5" });
    expect(setReasoningEffort).toHaveBeenCalledWith("low");
    expect(parent.executeNative).not.toHaveBeenCalled();
  });

  it("keeps the session model when singleModel is set", () => {
    const runtime = Object.assign(fakeRuntime(async () => reply("x")).runtime, {
      resolvedModel: () => "claude-opus-4-5",
      modelSelection: () => ({ agentModels: { explore: "claude-haiku-4-5" }, singleModel: true }),
    });
    expect(pickTitleModel(runtime as never)).toBe("claude-opus-4-5");
  });
});
