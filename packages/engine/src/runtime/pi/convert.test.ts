import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { NativeMessage } from "../types.js";
import { fromPiAssistant, mapPiStopReason, mapPiUsage, piRawIdentity, toPiContext, toPiTools, type PiTargetIdentity } from "./convert.js";

const target: PiTargetIdentity = { provider: "anthropic", api: "anthropic-messages", model: "claude-test" };

function usage(over: Partial<Usage> = {}): Usage {
  return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...over };
}

function assistant(content: AssistantMessage["content"], over: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", content, api: target.api, provider: target.provider, model: target.model, usage: usage(), stopReason: "stop", timestamp: 1, ...over };
}

describe("toPiContext", () => {
  it("maps system, tools, text, images and tool_use/tool_result pairs", () => {
    const messages: NativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "scan it" }, { type: "image", mediaType: "image/png", data: "QUJD" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "http", input: { url: "https://x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "200 OK" }, { type: "text", text: "continue" }] },
    ];
    const ctx = toPiContext("SYS", messages, [{ name: "http", description: "d", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }], target);
    expect(ctx.systemPrompt).toBe("SYS");
    expect(ctx.tools).toEqual([{ name: "http", description: "d", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }]);
    expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(ctx.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "scan it" }, { type: "image", data: "QUJD", mimeType: "image/png" }] });
    expect(ctx.messages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "t1", name: "http", arguments: { url: "https://x" } }] });
    expect(ctx.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "t1", toolName: "http", isError: false, content: [{ type: "text", text: "200 OK" }] });
    expect(ctx.messages[3]).toMatchObject({ role: "user", content: [{ type: "text", text: "continue" }] });
    const stamps = ctx.messages.map((m) => m.timestamp);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("carries is_error and demotes orphan tool_results to user text", () => {
    const ctx = toPiContext("", [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "run", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "boom", is_error: true }, { type: "tool_result", tool_use_id: "ghost", content: "stray" }] },
    ], [], target);
    expect(ctx.tools).toBeUndefined();
    expect(ctx.messages[1]).toMatchObject({ role: "toolResult", isError: true });
    expect(ctx.messages[2]).toMatchObject({ role: "user" });
    expect(JSON.stringify(ctx.messages[2])).toContain("stray");
  });

  it("drops empty text blocks and empty assistant turns", () => {
    const ctx = toPiContext("", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "user", content: [{ type: "text", text: "" }] },
    ], [], target);
    expect(ctx.messages).toHaveLength(1);
  });

  it("toPiTools passes raw JSON schema through", () => {
    expect(toPiTools([{ name: "n", description: "d", input_schema: { type: "object", properties: {} } }])[0]!.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("fromPiAssistant + providerRaw round trip", () => {
  const thinkingTurn = assistant([
    { type: "thinking", thinking: "plan the probe", thinkingSignature: "sig-1" },
    { type: "text", text: "probing" },
    { type: "toolCall", id: "c1", name: "http", arguments: { url: "https://x" } },
  ], { stopReason: "toolUse" });

  it("hides thinking from content, exposes it separately, and keeps the signature in providerRaw", () => {
    const out = fromPiAssistant(thinkingTurn, target);
    expect(out.content).toEqual([{ type: "text", text: "probing" }, { type: "tool_use", id: "c1", name: "http", input: { url: "https://x" } }]);
    expect(out.thinking).toBe("plan the probe");
    expect(out.providerRaw).toMatchObject({ ...piRawIdentity(target) });
    expect(JSON.stringify(out.providerRaw)).toContain("sig-1");
  });

  it("omits providerRaw when nothing would be lost", () => {
    expect(fromPiAssistant(assistant([{ type: "text", text: "hi" }]), target).providerRaw).toBeUndefined();
  });

  it("replays thinking verbatim for the same model after a JSON persist/resume round-trip", () => {
    const out = fromPiAssistant(thinkingTurn, target);
    const persisted = JSON.parse(JSON.stringify({ role: "assistant", content: out.content, providerRaw: out.providerRaw })) as NativeMessage;
    const ctx = toPiContext("", [{ role: "user", content: [{ type: "text", text: "go" }] }, persisted], [], target);
    const replayed = ctx.messages[1] as AssistantMessage;
    expect(replayed.content).toEqual(thinkingTurn.content);
  });

  it("drops thinking on identity mismatch (model switch) and rebuilds from visible blocks", () => {
    const out = fromPiAssistant(thinkingTurn, target);
    const ctx = toPiContext("", [{ role: "assistant", content: out.content, providerRaw: out.providerRaw }], [], { ...target, model: "other-model" });
    const replayed = ctx.messages[0] as AssistantMessage;
    expect(replayed.content.map((b) => b.type)).toEqual(["text", "toolCall"]);
    expect(replayed.model).toBe("other-model");
  });

  it("drops thinking when visible blocks were edited (compaction) so the signature never rides on changed text", () => {
    const out = fromPiAssistant(thinkingTurn, target);
    const edited = out.content.map((b) => (b.type === "text" ? { ...b, text: "summarised" } : b));
    const ctx = toPiContext("", [{ role: "assistant", content: edited, providerRaw: out.providerRaw }], [], target);
    expect((ctx.messages[0] as AssistantMessage).content.map((b) => b.type)).toEqual(["text", "toolCall"]);
  });

  it("drops raw when tool_use ids diverge", () => {
    const out = fromPiAssistant(thinkingTurn, target);
    const edited = out.content.map((b) => (b.type === "tool_use" ? { ...b, id: "other" } : b));
    const ctx = toPiContext("", [{ role: "assistant", content: edited, providerRaw: out.providerRaw }], [], target);
    expect((ctx.messages[0] as AssistantMessage).content.every((b) => b.type !== "thinking")).toBe(true);
  });

  it("ignores a Responses-API providerRaw (foreign sidecar)", () => {
    const ctx = toPiContext("", [{ role: "assistant", content: [{ type: "text", text: "x" }], providerRaw: { provider: "openai", model: target.model, wireApi: "responses", output: [{ type: "reasoning" }] } }], [], target);
    expect((ctx.messages[0] as AssistantMessage).content).toEqual([{ type: "text", text: "x" }]);
  });

  it("reports unparsable tool arguments instead of hiding them", () => {
    const out = fromPiAssistant(assistant([{ type: "toolCall", id: "c", name: "t", arguments: {}, argumentsError: "bad json" }]), target);
    expect(out.argumentErrors).toEqual({ c: "bad json" });
  });

  it("redacted thinking is preserved only in the sidecar", () => {
    const out = fromPiAssistant(assistant([{ type: "thinking", thinking: "", thinkingSignature: "enc", redacted: true }, { type: "text", text: "a" }]), target);
    expect(out.thinking).toBe("");
    expect(JSON.stringify(out.providerRaw)).toContain("enc");
  });
});

describe("usage and stop reason mapping", () => {
  it("inputTokens is the TOTAL prompt (pi input excludes cache)", () => {
    expect(mapPiUsage(usage({ input: 10, output: 4, cacheRead: 100, cacheWrite: 20 }))).toEqual({ inputTokens: 130, outputTokens: 4, cachedInputTokens: 100, cacheWriteTokens: 20 });
    expect(mapPiUsage(usage({ input: 7, output: 1 }))).toEqual({ inputTokens: 7, outputTokens: 1 });
  });

  it("maps stop reasons into our taxonomy", () => {
    expect(mapPiStopReason("stop", false)).toBe("end_turn");
    expect(mapPiStopReason("stop", true)).toBe("tool_use");
    expect(mapPiStopReason("toolUse", true)).toBe("tool_use");
    expect(mapPiStopReason("length", false)).toBe("max_tokens");
    expect(mapPiStopReason("error", false)).toBe("error");
    expect(mapPiStopReason("aborted", false)).toBe("error");
  });
});
