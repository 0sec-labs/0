import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { estimateCost } from "@0/shared";
import { LlmApiRuntime } from "./llm-api.js";
import type { NativeRuntimeResult, RuntimeResult } from "./types.js";

beforeEach(() => {
  for (const name of ["ZERO_FORCE_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_PROVIDER", "ZERO_MODEL", "ZERO_WORKBENCH_PROVIDER_PROXY", "ZERO_WORKBENCH_PROVIDER_PROXY_TOKEN"]) vi.stubEnv(name, "");
  vi.stubEnv("ZERO_LLM_FALLBACK", "");
  vi.stubEnv("ZERO_SKIP_PROVIDER_BANNER", "1");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function response(usage: unknown, native: boolean): Promise<RuntimeResult | NativeRuntimeResult> {
  const envelope = { id: "receipt-fixture", status: "completed", output_text: "Fixture completed.",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture completed." }] }],
    ...(usage === undefined ? {} : { usage }) };
  const fetchMock = vi.fn<typeof fetch>(async () => native
    ? new Response(`data: ${JSON.stringify({ type: "response.completed", response: envelope })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    : Response.json(envelope));
  vi.stubGlobal("fetch", fetchMock);
  const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "openai", model: "gpt-4o", env: {
    OPENAI_API_KEY: "synthetic-only", OPENAI_BASE_URL: "https://receipt.fixture/v1", OPENAI_WIRE_API: "responses",
    ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1",
  } });
  const onUsage = vi.fn();
  const result = native ? await runtime.executeNative("Synthetic receipt fixture.", [{ role: "user", content: [{ type: "text", text: "Complete the fixture." }] }], [], { onUsage })
    : await runtime.execute("Synthetic receipt fixture.");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://receipt.fixture/v1/responses");
  if (native) expect(onUsage).toHaveBeenCalledTimes(result.usage ? 1 : 0);
  return result;
}

for (const native of [false, true]) {
  const route = native ? "native SSE" : "plain JSON";
  it.each([undefined, {}, [], { input_tokens: 10 }, { output_tokens: 2 },
    { input_tokens: null, output_tokens: 2 }, { input_tokens: "10", output_tokens: 2 },
    { input_tokens: 10, output_tokens: -1 }, { input_tokens: 10, output_tokens: 0.5 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 2 }])
  (`${route}: leaves missing or malformed Responses usage unknown: %j`, async usage => {
    expect((await response(usage, native)).usage).toBeUndefined();
  });
  it(`${route}: retains a genuine zero-count receipt`, async () => {
    expect((await response({ input_tokens: 0, output_tokens: 0 }, native)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
  it(`${route}: preserves valid bounded cache discounts`, async () => {
    expect((await response({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 5 } }, native)).usage)
      .toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 5 });
  });
  it.each(["5", -1, 0.5, 11, null])(`${route}: ignores invalid cache discounts conservatively: %j`, async cached => {
    const result = await response({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: cached } }, native);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(estimateCost(result.usage!, "gpt-4o")).toBe(estimateCost({ inputTokens: 10, outputTokens: 2 }, "gpt-4o"));
  });
}

it.each(["5", 11])("Chat Completions also ignores invalid cache discounts: %j", async cached => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({
    choices: [{ message: { role: "assistant", content: "Fixture completed." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: cached } },
  })));
  const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "openai", model: "gpt-4o", env: {
    OPENAI_API_KEY: "synthetic-only", OPENAI_BASE_URL: "https://receipt.fixture/v1", OPENAI_WIRE_API: "chat_completions",
    ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1",
  } });
  expect((await runtime.executeNative("Fixture", [{ role: "user", content: [{ type: "text", text: "Fixture" }] }], [])).usage)
    .toEqual({ inputTokens: 10, outputTokens: 2 });
});
