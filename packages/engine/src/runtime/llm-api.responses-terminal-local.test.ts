import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, __resetFallbackChainForTests } from "./llm-api.js";
import type { NativeMessage, RuntimeConfig } from "./types.js";

// Local-only port of PR #206's focused regressions. No provider request leaves this mock.
const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect README.md" }] }];
const codexConfig: Partial<RuntimeConfig> = { provider: "chatgpt-codex", model: "gpt-fixture", env: { ZERO_CHATGPT_ACCESS_TOKEN: "fixture-access", ZERO_CHATGPT_ACCOUNT_ID: "fixture-account" } };
async function request(config: Partial<RuntimeConfig> = {}) {
  const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, ...config });
  return runtime.executeNative("Inspect the synthetic workspace.", structuredClone(messages), [{ name: "inspect", description: "Inspect a path", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
}
function expectToolResult(result: Awaited<ReturnType<typeof request>>) {
  expect(result.error).toBeUndefined();
  expect(result.stopReason).toBe("tool_use");
  expect(result.content).toEqual([{ type: "tool_use", id: "call_fixture", name: "inspect", input: { path: "README.md" } }]);
  expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
}

describe("canonical Responses terminal regressions (approved PR #206)", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    for (const key of ["ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_PROVIDER", "ZERO_MODEL", "ZERO_WORKBENCH_PROVIDER_PROXY", "ZERO_WORKBENCH_PROVIDER_PROXY_TOKEN", "ZERO_CHATGPT_OAUTH_REFRESH_TOKEN", "ZERO_TRACE_NATIVE_RESPONSES", "ZERO_LLM_STREAM_IDLE_TIMEOUT_MS", "ZERO_LLM_STREAM_EVENT_IDLE_TIMEOUT_MS"]) vi.stubEnv(key, "");
    vi.stubEnv("ZERO_LLM_FALLBACK", "");
    vi.stubEnv("ZERO_SKIP_PROVIDER_BANNER", "1");
    vi.stubEnv("ZERO_LLM_STREAM_MAX_ATTEMPTS", "1");
    __resetFallbackChainForTests();
    fetchMock = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected mock transport request"); });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    __resetFallbackChainForTests();
  });
  it.each([
    { provider: "openai" as const, terminal: "response.completed", env: { OPENAI_API_KEY: "fixture", OPENAI_WIRE_API: "responses" } },
    { provider: "openrouter" as const, terminal: "response.done", env: { OPENROUTER_API_KEY: "fixture", OPENROUTER_WIRE_API: "responses" } },
    { provider: "chatgpt-codex" as const, terminal: "response.completed", env: codexConfig.env },
  ])("finishes $provider/$terminal without HTTP EOF or teardown acknowledgement", async ({ provider, terminal, env }) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const events = [
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_fixture", name: "inspect", arguments: '{"path":"README.md"}' } },
      { type: terminal, response: { status: "completed", output: [], usage: { input_tokens: 7, output_tokens: 3 } } },
    ];
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; value.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))); },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } }));
    let result: Awaited<ReturnType<typeof request>> | undefined;
    const pending = request({ provider, model: "gpt-fixture", env }).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBeDefined();
      expectToolResult(result!);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      // On the unfixed implementation EOF releases the blocked read, allowing
      // the failing regression itself to clean up without waiting for a timer.
      if (!result) controller.close();
      await pending;
    }
  });

  it.each([
    { name: "error", tail: `data: ${JSON.stringify({ type: "error", code: "fixture_rejection" })}\n\n` },
    { name: "failed", tail: `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed" } })}\n\n` },
    { name: "incomplete", tail: `data: ${JSON.stringify({ type: "response.incomplete" })}\n\n` },
    { name: "malformed", tail: "data: invalid-json\n\n" },
    { name: "new tool output", tail: `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "post-terminal", name: "inspect", arguments: "{}" } })}\n\n` },
    { name: "new text delta", tail: `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "must not be emitted" })}\n\n` },
  ])("rejects already-buffered $name after completion without promoting tools", async ({ tail }) => {
    const wire = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed",
      output: [{ type: "function_call", call_id: "safe-before-contradiction", name: "inspect", arguments: "{}" }],
      usage: { input_tokens: 7, output_tokens: 3 },
    } })}\n\n` + tail;
    fetchMock.mockResolvedValueOnce(new Response(wire));
    const deltas: string[] = [];
    const model = new LlmApiRuntime({ type: "api", timeout: 1000, ...codexConfig });
    const result = await model.executeNative("Inspect.", structuredClone(messages), [], { onDelta: (_kind, text) => deltas.push(text) });
    expect(result.stopReason).toBe("error");
    expect(result.content.some(block => block.type === "tool_use")).toBe(false);
    expect(result.providerRaw).toBeUndefined();
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(deltas).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not wait for or assemble a partial frame after completed output", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed",
          output: [{ type: "function_call", call_id: "call_fixture", name: "inspect", arguments: '{"path":"README.md"}' }],
          usage: { input_tokens: 7, output_tokens: 3 },
        } })}\n\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"partial-unsafe"`));
      }, cancel,
    })));
    let result: Awaited<ReturnType<typeof request>> | undefined;
    const pending = request(codexConfig).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeDefined();
    expectToolResult(result!);
    expect(JSON.stringify(result)).not.toContain("partial-unsafe");
    expect(cancel).toHaveBeenCalledOnce();
    await pending;
  });

  it.each(["delta", "usage"])("keeps same-read operator cancellation from %s ahead of completed tools", async origin => {
    vi.useFakeTimers(); process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "3";
    const operator = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const events = [
      { type: "response.output_text.delta", delta: "observed" },
      { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "must-not-run", name: "inspect", arguments: "{}" }], usage: { input_tokens: 7, output_tokens: 3 } } },
    ];
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))); }, cancel,
    })));
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
    const model = new LlmApiRuntime({ type: "api", timeout: 1000, ...codexConfig });
    let result: Awaited<ReturnType<typeof request>> | undefined;
    const pending = model.executeNative("Inspect.", structuredClone(messages), [], {
      onDelta: () => { if (origin === "delta") operator.abort(); },
      onUsage: value => { usage.push(value); if (origin === "usage") operator.abort(); },
    }, operator.signal).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toMatchObject({ stopReason: "error", cancelled: true, usage: { inputTokens: 7, outputTokens: 3 } });
    expect(result!.content.some(block => block.type === "tool_use")).toBe(false);
    expect(result!.providerRaw).toBeUndefined();
    expect(usage).toEqual([{ inputTokens: 7, outputTokens: 3 }]);
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
    await pending;
  });

  it("keeps late reasoning-fallback cancellation ahead of assembled tools and opaque replay", async () => {
    const operator = new AbortController();
    fetchMock.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
      status: "completed", usage: { input_tokens: 7, output_tokens: 3 }, output: [
        { type: "reasoning", summary: [{ text: "Reasoning fallback" }], encrypted_content: "opaque-fixture" },
        { type: "function_call", call_id: "must-not-run", name: "inspect", arguments: "{}" },
      ],
    } })}\n\n`));
    const onThinking = vi.fn(() => operator.abort());
    const model = new LlmApiRuntime({ type: "api", timeout: 1000, ...codexConfig });
    const result = await model.executeNative("Inspect.", structuredClone(messages), [], { onThinking }, operator.signal);
    expect(onThinking).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ stopReason: "error", cancelled: true, usage: { inputTokens: 7, outputTokens: 3 } });
    expect(result.content.some(block => block.type === "tool_use")).toBe(false);
    expect(result.providerRaw).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves observed text and usage when cancellation coincides with an output-cap checkpoint", async () => {
    const operator = new AbortController();
    fetchMock.mockResolvedValueOnce(new Response([
      { type: "response.output_text.delta", delta: "Observed text" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 7, output_tokens: 3 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    const model = new LlmApiRuntime({ type: "api", timeout: 1000, ...codexConfig });
    const result = await model.executeNative("Inspect.", structuredClone(messages), [], { onUsage: () => operator.abort() }, operator.signal);
    expect(result).toMatchObject({ stopReason: "error", cancelled: true, content: [{ type: "text", text: "Observed text" }], usage: { inputTokens: 7, outputTokens: 3 } });
    expect(result.providerRaw).toBeUndefined(); expect(result.checkpoint).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not wait for teardown during pending-read cancellation or relabel a deadline-first abort", async () => {
    vi.useFakeTimers();
    for (const deadlineFirst of [false, true]) {
      const operator = new AbortController(); const cancel = vi.fn(() => new Promise<void>(() => {}));
      fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
      const model = new LlmApiRuntime({ type: "api", timeout: 1000, ...codexConfig });
      let result: Awaited<ReturnType<typeof request>> | undefined;
      const pending = model.executeNative("Inspect.", structuredClone(messages), [], undefined, operator.signal).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(deadlineFirst ? 1000 : 0);
      operator.abort(); await vi.advanceTimersByTimeAsync(0);
      expect(result).toBeDefined(); expect(result!.stopReason).toBe("error");
      expect(result!.error).toMatch(deadlineFirst ? /timed out/ : /cancelled by operator/);
      expect(result!.cancelled).toBe(deadlineFirst ? undefined : true);
      expect(result!.usage).toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
      await pending;
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not wait for teardown after a byte-idle watchdog expires", async () => {
    vi.useFakeTimers(); process.env.ZERO_LLM_STREAM_IDLE_TIMEOUT_MS = "10";
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
    let result: Awaited<ReturnType<typeof request>> | undefined;
    const pending = request(codexConfig).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10);
    expect(result).toMatchObject({ stopReason: "error" }); expect(result!.error).toMatch(/stalled/);
    expect(result!.cancelled).toBeUndefined(); expect(result!.usage).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
    await pending;
  });

});
