import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRates, hasKnownPricing } from "@0/shared";
import { LlmApiRuntime, parseLlmFallbackChain, resolveFailoverProvider } from "./llm-api.js";
import type { NativeMessage, NativeToolDef } from "./types.js";

const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect the source" }] }];
const tools: NativeToolDef[] = [{ name: "read_file", description: "Read source", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const completion = {
  choices: [{ message: { content: "Together answer" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
};
// ZERO_CHATGPT_AUTH_FILE points at a nonexistent path so a developer's real
// ~/.codex/auth.json can never win ambient detection inside these tests.
const BASE_ENV = { ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_CHATGPT_AUTH_FILE: "/nonexistent/0-test/auth.json" } as const;
type Config = Omit<ConstructorParameters<typeof LlmApiRuntime>[0], "type" | "timeout">;
function make(config: Config) { return new LlmApiRuntime({ type: "api", timeout: 1000, ...config }); }

function runtime(model = "openai/gpt-oss-120b", env: Record<string, string> = {}) {
  return make({ provider: "together", model,
    env: { TOGETHER_API_KEY: "synthetic-together-key", ...BASE_ENV, ...env } });
}

beforeEach(() => {
  // Root runtimes merge process.env: ambient provider keys must not make
  // synthetic credential-order fixtures depend on the developer account.
  for (const key of Object.keys(process.env)) {
    if (/^(?:ZERO_|OPENAI_|OPENROUTER_|ANTHROPIC_|AZURE_OPENAI_|DEEPSEEK_|Z_AI_|KIMI_|QWEN_|XAI_|OPENCODE_|CLINE_|TOGETHER_|COPILOT_|GOOGLE_)/.test(key)) vi.stubEnv(key, undefined);
  }
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Together AI transport", () => {
  it("posts OpenAI-shaped chat completions with a Bearer key to the default endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    const rt = runtime();
    const result = await rt.executeNative("Review carefully", messages, tools);
    expect(rt.resolvedProvider()).toBe("together");
    expect(result).toMatchObject({ content: [{ type: "text", text: "Together answer" }], stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.together.ai/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer synthetic-together-key");
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.has("api-key")).toBe(false);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "openai/gpt-oss-120b", max_tokens: 8192 });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("stream");
    expect(body.tools[0].function).toMatchObject({ name: "read_file", parameters: { type: "object", required: ["path"] } });
  });

  it("serves ordinary execute as well as native calls", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion)));
    expect(await runtime().execute("Review source")).toMatchObject({ output: "Together answer", exitCode: 0, usage: { inputTokens: 12, outputTokens: 4 } });
  });

  it("parses tool calls and continues after a tool result on the same connection", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null, reasoning_content: "thinking", tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } }] }, finish_reason: "tool_calls" }] }))
      .mockResolvedValueOnce(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    const rt = runtime();
    const first = await rt.executeNative("Review", messages, tools);
    expect(first).toMatchObject({ stopReason: "tool_use", content: expect.arrayContaining([{ type: "tool_use", id: "call-read", name: "read_file", input: { path: "src/main.ts" } }]) });
    const result = await rt.executeNative("Review", [...messages,
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-read", content: "export const answer = 42;" }] },
    ], tools);
    expect(result.stopReason).toBe("end_turn");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } }] }),
      { role: "tool", tool_call_id: "call-read", content: "export const answer = 42;" },
    ]));
  });

  it("strips the together/ routing prefix exactly once and keeps vendor model ids", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    const rt = runtime("together/meta-llama/Llama-3.3-70B-Instruct-Turbo");
    await rt.executeNative("Review", messages, []);
    expect(rt.resolvedModel()).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo");
    // An id that itself begins with `together/` needs the prefix twice.
    expect(runtime("together/together/Tev1-4B-experimental").resolvedModel()).toBe("together/Tev1-4B-experimental");
  });

  it.each([
    [undefined, "https://api.together.ai/v1/chat/completions"],
    ["", "https://api.together.ai/v1/chat/completions"],
    ["https://api.together.ai", "https://api.together.ai/v1/chat/completions"],
    ["https://api.together.ai/", "https://api.together.ai/v1/chat/completions"],
    ["https://api.together.ai/v1", "https://api.together.ai/v1/chat/completions"],
    ["https://api.together.ai/v1/", "https://api.together.ai/v1/chat/completions"],
    ["https://us-api.together.ai/v1", "https://us-api.together.ai/v1/chat/completions"],
    ["https://gateway.example/together/v1", "https://gateway.example/together/v1/chat/completions"],
  ])("resolves TOGETHER_BASE_URL=%s to %s (bare SDK origins gain /v1)", async (override, expected) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    await runtime("openai/gpt-oss-120b", override === undefined ? {} : { TOGETHER_BASE_URL: override }).executeNative("Review", messages, []);
    expect(fetchMock.mock.calls[0][0]).toBe(expected);
  });
});

describe("Together AI provider selection", () => {
  const ENV = { TOGETHER_API_KEY: "synthetic-together-key", ...BASE_ENV };

  it("is selected only by the together/ prefix, never by model family", () => {
    // `Qwen/…` and `zai-org/GLM-…` are Together ids but belong to other families here.
    const withQwen = make({ model: "Qwen/Qwen3.5-9B", env: { ...ENV, QWEN_API_KEY: "synthetic-qwen-key" } });
    expect(withQwen.resolvedProvider()).toBe("qwen");
    const withZai = make({ model: "zai-org/GLM-5.2", env: { ...ENV, Z_AI_API_KEY: "synthetic-zai-key" } });
    expect(withZai.resolvedProvider()).toBe("z-ai");
    const prefixed = make({ model: "together/Qwen/Qwen3.5-9B", env: { ...ENV, QWEN_API_KEY: "synthetic-qwen-key", Z_AI_API_KEY: "synthetic-zai-key" } });
    expect(prefixed.resolvedProvider()).toBe("together");
    expect(prefixed.resolvedModel()).toBe("Qwen/Qwen3.5-9B");
  });

  it("never outranks a direct provider key in the ambient credential order", () => {
    for (const [key, provider] of [["OPENAI_API_KEY", "openai"], ["OPENROUTER_API_KEY", "openrouter"], ["DEEPSEEK_API_KEY", "deepseek"], ["XAI_API_KEY", "xai"], ["CLINE_API_KEY", "cline"], ["ANTHROPIC_API_KEY", "anthropic"]] as const) {
      expect(make({ env: { ...ENV, [key]: "synthetic-other-key" } }).resolvedProvider()).toBe(provider);
    }
  });

  it("is used when it is the only configured credential", () => {
    const rt = make({ env: ENV });
    expect(rt.resolvedProvider()).toBe("together");
    expect(rt.resolvedModel()).toBe("openai/gpt-oss-120b");
  });

  it("honours ZERO_SELECTED_PROVIDER=together over other credentials", () => {
    const rt = make({ env: { ...ENV, ZERO_SELECTED_PROVIDER: "together", ZERO_MODEL: "meta-llama/Llama-3.3-70B-Instruct-Turbo", OPENAI_API_KEY: "synthetic-other-key" } });
    expect(rt.resolvedProvider()).toBe("together");
    expect(rt.resolvedModel()).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo");
  });

  it("requires the Together connection's own nonblank credential", () => {
    expect(resolveFailoverProvider("together", "openai/gpt-oss-120b", { OPENAI_API_KEY: "synthetic-other-key" })).toBeUndefined();
    expect(resolveFailoverProvider("together", "openai/gpt-oss-120b", { TOGETHER_API_KEY: "   " })).toBeUndefined();
    expect(resolveFailoverProvider("together", "openai/gpt-oss-120b", { TOGETHER_API_KEY: "synthetic-together-key" }))
      .toEqual({ apiKey: "synthetic-together-key", baseUrl: "https://api.together.ai/v1", wireApi: "chat_completions" });
  });

  it.each(["together/openai/gpt-oss-120b", "together/meta-llama/Llama-3.3-70B-Instruct-Turbo"])("fails closed for %s without Together auth even when other providers are configured", model => {
    expect(() => make({ model, env: { ...BASE_ENV, TOGETHER_API_KEY: "", OPENAI_API_KEY: "synthetic-other-key", OPENROUTER_API_KEY: "synthetic-other-router-key" } })).toThrow(/Together model requires TOGETHER_API_KEY/);
    expect(() => make({ model, apiKey: "synthetic-ambiguous-key", env: { ...BASE_ENV, TOGETHER_API_KEY: "" } })).toThrow(/explicit Together provider/);
    expect(() => make({ provider: "openai", model, env: { ...ENV, OPENAI_API_KEY: "synthetic-other-key" } })).toThrow(/require the Together provider/);
  });

  it("accepts together in the ZERO_LLM_FALLBACK chain", () => {
    expect(parseLlmFallbackChain({ ZERO_LLM_FALLBACK: "together:openai/gpt-oss-120b,openai:gpt-4o" }))
      .toMatchObject([{ provider: "together", model: "openai/gpt-oss-120b" }, { provider: "openai", model: "gpt-4o" }]);
  });

  it("keeps the connection when switching models and forking a subagent", async () => {
    const rt = runtime();
    rt.reconfigure({ model: "together/deepseek-ai/DeepSeek-V4.1-Flash" });
    expect(rt.resolvedModel()).toBe("deepseek-ai/DeepSeek-V4.1-Flash");
    const child = await rt.forkForSubagent(500);
    expect(child.resolvedProvider()).toBe("together");
    expect(child.resolvedModel()).toBe("deepseek-ai/DeepSeek-V4.1-Flash");
  });

  it("prices a discovered Together model through the actual runtime route", async () => {
    const id = "synthetic-org/Runtime-Route-Price-9B";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      { id, type: "chat", pricing: { input: 0.3, output: 1.2, cached_input: 0.006 } },
    ])));
    const rt = runtime(id);
    await rt.availableModelCatalog();
    expect(rt.resolvedModel()).toBe(id);
    expect(rt.resolvedPricingModel()).toBe(`together/${id}`);
    expect(getRates(rt.resolvedPricingModel())).toEqual({ input: 0.3, output: 1.2, cachedInput: 0.006 });
    expect(hasKnownPricing(`openai/${id}`)).toBe(false);
  });

  it("lists only models with published prices unless TOGETHER_MODEL_LIST=all", async () => {
    const catalog = [
      { id: "synthetic-org/Priced-Runtime-9B", type: "chat", context_length: 32768, pricing: { input: 0.1, output: 0.2 } },
      { id: "synthetic-org/Unpriced-Runtime-9B", type: "chat", context_length: 32768, pricing: {} },
    ];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json(catalog)));
    expect((await runtime().availableModelCatalog()).map(model => model.id)).toEqual(["synthetic-org/Priced-Runtime-9B"]);
    for (const value of ["all", " ALL "]) {
      expect((await runtime("openai/gpt-oss-120b", { TOGETHER_MODEL_LIST: value }).availableModelCatalog()).map(model => model.id))
        .toEqual(["synthetic-org/Priced-Runtime-9B", "synthetic-org/Unpriced-Runtime-9B"]);
    }
    expect((await runtime("openai/gpt-oss-120b", { TOGETHER_MODEL_LIST: "priced" }).availableModelCatalog()).map(model => model.id))
      .toEqual(["synthetic-org/Priced-Runtime-9B"]);
  });

  it.each([false, true])("preserves an unchanged native together/ ID through child forks (singleModel=%s)", async singleModel => {
    const rt = make({ provider: "together", model: "together/together/Tev1-4B-experimental", singleModel, env: ENV });
    const child = await rt.forkForSubagent(500);
    expect(child.resolvedModel()).toBe("together/Tev1-4B-experimental");
    expect(child.connectionIdentity()).toBe(rt.connectionIdentity());
    expect((await child.forkForSubagent(400)).resolvedModel()).toBe(rt.resolvedModel());
    expect((await rt.forkForSubagent(400, { model: rt.resolvedModel() })).resolvedModel()).toBe(rt.resolvedModel());
  });

  it("normalizes explicit and role-pinned child selections once", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    const selected = "together/together/Tev1-4B-experimental";
    const rt = make({ provider: "together", model: "openai/gpt-oss-120b", agentModels: { discovery: selected }, env: ENV });
    for (const selection of [{ model: selected }, { role: "discovery" }]) {
      const child = await rt.forkForSubagent(500, selection);
      expect(child.resolvedModel()).toBe("together/Tev1-4B-experimental");
      expect(child.resolvedProvider()).toBe("together");
      await child.executeNative("Review", messages, []);
    }
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body)).model).toBe("together/Tev1-4B-experimental");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-together-key");
    }
  });

  it("restores a private binding without stripping the native ID or rediscovering accounts", async () => {
    const rt = runtime("together/together/Tev1-4B-experimental");
    const binding = rt.exportPrivateWorkerBinding();
    vi.stubEnv("TOGETHER_API_KEY", "synthetic-replacement-account");
    vi.stubEnv("TOGETHER_BASE_URL", "https://other.example/v1");
    const restored = LlmApiRuntime.fromPrivateWorkerBinding(binding);
    expect(restored.resolvedModel()).toBe("together/Tev1-4B-experimental");
    expect(restored.connectionIdentity()).toBe(rt.connectionIdentity());
    expect((await restored.forkForSubagent(500)).resolvedModel()).toBe(rt.resolvedModel());
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    await restored.executeNative("Review", messages, []);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.together.ai/v1/chat/completions");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer synthetic-together-key");
  });

  it("names the provider in missing-credential guidance", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => make({ provider: "together", model: "openai/gpt-oss-120b", env: { ...BASE_ENV, TOGETHER_API_KEY: "" } })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
