import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, __resetFallbackChainForTests, isPolicyRefusalResult } from "./llm-api.js";
import type { NativeMessage, NativeRuntimeResult, RuntimeConfig } from "./types.js";

// The exact error string consumeResponsesStream produces for a provider-side
// policy rejection: HTTP 200 SSE that streams, then ends with response.failed
// carrying a *_policy error code (observed live as `cyber_policy`).
function refusalError(code = "cyber_policy"): string {
  return `OpenAI API error: Responses terminal failure ${JSON.stringify({
    event: "response.failed",
    status: "failed",
    code,
    errorType: "refusal",
    reason: "policy block",
  })}`;
}

describe("isPolicyRefusalResult (pure classifier)", () => {
  const refused = (over: Partial<NativeRuntimeResult> = {}): NativeRuntimeResult => ({
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    durationMs: 1,
    error: refusalError(),
    ...over,
  });

  it("recognises a Responses terminal refusal with a *_policy code", () => {
    expect(isPolicyRefusalResult(refused())).toBe(true);
    expect(isPolicyRefusalResult(refused({ error: refusalError("self_harm_policy") }))).toBe(true);
  });

  it("rejects non-policy terminal codes", () => {
    expect(isPolicyRefusalResult(refused({ error: refusalError("server_error") }))).toBe(false);
    expect(isPolicyRefusalResult(refused({ error: refusalError("rate_limit_exceeded") }))).toBe(false);
  });

  it("rejects outcomes that are not terminal failures at all", () => {
    expect(isPolicyRefusalResult(refused({ error: "OpenAI API error: stream completed without final response (HTTP 200; events=response.output_text.delta; malformed=0; trailing=0)" }))).toBe(false);
    expect(isPolicyRefusalResult(refused({ error: "OpenAI API error: response stream failed" }))).toBe(false);
    expect(isPolicyRefusalResult(refused({ error: undefined }))).toBe(false);
  });

  it("never misfires on successful output or cancellations, even with matching text", () => {
    expect(isPolicyRefusalResult(refused({ stopReason: "tool_use", content: [{ type: "tool_use", id: "call_x", name: "inspect", input: {} }] }))).toBe(false);
    expect(isPolicyRefusalResult(refused({ stopReason: "end_turn" }))).toBe(false);
    expect(isPolicyRefusalResult(refused({ cancelled: true }))).toBe(false);
  });

  it("rejects a malformed envelope after the marker", () => {
    expect(isPolicyRefusalResult(refused({ error: "OpenAI API error: Responses terminal failure not-json" }))).toBe(false);
  });
});

// ── executeNative failover integration (all traffic stays on mock fetch) ──

const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect README.md" }] }];
const sse = (frames: unknown[]): string => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

// Primary (openai Responses wire): streams a fragment, then the safety
// classifier rejects with HTTP 200 + response.failed code=cyber_policy.
const primaryRefusal = sse([
  { type: "response.output_text.delta", delta: "scanning the target" },
  {
    type: "response.failed",
    response: {
      status: "failed",
      usage: { input_tokens: 21, output_tokens: 4 },
      error: { code: "cyber_policy", type: "refusal", message: "policy block" },
    },
  },
]);

// Fallback (deepseek, also Responses wire): completes with a tool call.
const fallbackCompletion = sse([
  {
    type: "response.completed",
    response: {
      status: "completed",
      output: [{ type: "function_call", call_id: "call_fixture", name: "inspect", arguments: '{"path":"README.md"}' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  },
]);

const failoverConfig: Partial<RuntimeConfig> = {
  provider: "openai",
  model: "gpt-fixture",
  env: {
    OPENAI_API_KEY: "fixture-primary",
    OPENAI_WIRE_API: "responses",
    DEEPSEEK_API_KEY: "fixture-fallback",
    ZERO_LLM_FALLBACK: "deepseek:deepseek-v4-flash",
    ZERO_LLM_STREAM_MAX_ATTEMPTS: "1",
    ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1",
  },
};

function expectToolUse(result: NativeRuntimeResult) {
  expect(result.error).toBeUndefined();
  expect(result.stopReason).toBe("tool_use");
  expect(result.content).toEqual([{ type: "tool_use", id: "call_fixture", name: "inspect", input: { path: "README.md" } }]);
}

describe("executeNative policy-refusal failover", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    vi.stubEnv("ZERO_LLM_STREAM_MAX_ATTEMPTS", "1");
    vi.stubEnv("ZERO_SUPPRESS_PROVIDER_STARTUP_LOG", "1");
    __resetFallbackChainForTests();
    fetchMock = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected mock transport request"); });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    __resetFallbackChainForTests();
  });

  function urlsCalled(): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
  }

  it("fails over to the next provider and completes the tool call, carrying refused usage", async () => {
    fetchMock.mockResolvedValueOnce(new Response(primaryRefusal, { headers: { "content-type": "text/event-stream" } }));
    fetchMock.mockResolvedValueOnce(new Response(fallbackCompletion, { headers: { "content-type": "text/event-stream" } }));

    const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, ...failoverConfig });
    const result = await runtime.executeNative("Inspect the synthetic workspace.", structuredClone(messages), []);

    expect(urlsCalled()).toEqual([
      expect.stringContaining("api.openai.com"),
      expect.stringContaining("api.deepseek.com"),
    ]);
    expectToolUse(result);
    // Refused primary tokens (21/4) must not vanish: final usage sums both legs.
    expect(result.usage).toEqual({ inputTokens: 26, outputTokens: 6 });
  });

  it("keeps the refusal terminal and usage unchanged when no fallback chain is configured", async () => {
    fetchMock.mockResolvedValueOnce(new Response(primaryRefusal, { headers: { "content-type": "text/event-stream" } }));
    const { env: _, ...noFallback } = failoverConfig;
    const runtime = new LlmApiRuntime({
      type: "api",
      timeout: 1000,
      ...noFallback,
      env: { OPENAI_API_KEY: "fixture-primary", OPENAI_WIRE_API: "responses", ZERO_LLM_STREAM_MAX_ATTEMPTS: "1", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" },
    });
    const result = await runtime.executeNative("Inspect the synthetic workspace.", structuredClone(messages), []);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("cyber_policy");
    expect(result.error).toContain("Responses terminal failure");
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 4 });
  });

  it("skips chain entries whose credentials are absent and keeps the refusal terminal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(primaryRefusal, { headers: { "content-type": "text/event-stream" } }));
    const { env: _, ...withChain } = failoverConfig;
    const runtime = new LlmApiRuntime({
      type: "api",
      timeout: 1000,
      ...withChain,
      // Chain names deepseek but DEEPSEEK_API_KEY is blanked (config env
      // overrides the ambient shell) → entry must be skipped.
      env: { OPENAI_API_KEY: "fixture-primary", OPENAI_WIRE_API: "responses", DEEPSEEK_API_KEY: "", ZERO_LLM_FALLBACK: "deepseek:deepseek-v4-flash", ZERO_LLM_STREAM_MAX_ATTEMPTS: "1", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" },
    });
    const result = await runtime.executeNative("Inspect the synthetic workspace.", structuredClone(messages), []);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("cyber_policy");
  });

  it("merges usage from every refused leg and surfaces the last refusal when the chain exhausts", async () => {
    // Primary refuses, fallback also refuses (second refusal, different usage).
    fetchMock.mockResolvedValueOnce(new Response(primaryRefusal, { headers: { "content-type": "text/event-stream" } }));
    fetchMock.mockResolvedValueOnce(new Response(sse([
      {
        type: "response.failed",
        response: {
          status: "failed",
          usage: { input_tokens: 7, output_tokens: 1 },
          error: { code: "cyber_policy", type: "refusal", message: "policy block" },
        },
      },
    ]), { headers: { "content-type": "text/event-stream" } }));

    const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, ...failoverConfig });
    const result = await runtime.executeNative("Inspect the synthetic workspace.", structuredClone(messages), []);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("cyber_policy");
    expect(result.usage).toEqual({ inputTokens: 28, outputTokens: 5 });
  });

  it("preserves refused usage when the fallback exhausts its empty-stream retries", async () => {
    vi.stubEnv("ZERO_LLM_STREAM_MAX_ATTEMPTS", "2");
    fetchMock.mockResolvedValueOnce(new Response(primaryRefusal, { headers: { "content-type": "text/event-stream" } }));
    for (let attempt = 0; attempt < 2; attempt++) {
      fetchMock.mockResolvedValueOnce(new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    }
    const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, ...failoverConfig });
    const result = await runtime.executeNative("Inspect the synthetic workspace.", structuredClone(messages), []);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("retried 2 times");
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 4 });
  });

  it("does not fail over on a non-policy terminal failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(sse([
      {
        type: "response.failed",
        response: {
          status: "failed",
          usage: { input_tokens: 21, output_tokens: 4 },
          error: { code: "server_error", type: "server_error", message: "boom" },
        },
      },
    ]), { headers: { "content-type": "text/event-stream" } }));

    const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, ...failoverConfig });
    const result = await runtime.executeNative("Inspect the synthetic workspace.", structuredClone(messages), []);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("server_error");
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 4 });
  });

});
