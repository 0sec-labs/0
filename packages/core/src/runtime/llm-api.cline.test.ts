import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, resolveFailoverProvider } from "./llm-api.js";
import type { NativeMessage, NativeToolDef } from "./types.js";

const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect the source" }] }];
const tools: NativeToolDef[] = [{ name: "read_file", description: "Read source", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const completion = { choices: [{ message: { content: "Cline answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } };
function runtime(model = "cline-pass/glm-5.3") {
  return new LlmApiRuntime({ type: "api", provider: "cline", model, timeout: 1000,
    env: { CLINE_API_KEY: "synthetic-cline-key", CLINE_BASE_URL: "https://selected.example/api/v1", ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1" } });
}

beforeEach(() => {
  for (const key of ["ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_MODEL", "ZERO_LLM_FALLBACK", "ZERO_WORKBENCH_PROVIDER_PROXY", "ZERO_WORKBENCH_PROVIDER_PROXY_TOKEN"]) vi.stubEnv(key, undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Cline and ClinePass transport", () => {
  it.each(["ordinary", "native"])("requests JSON explicitly on the %s path when Cline defaults to streaming", async path => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.stream === false ? Response.json(completion)
        : new Response('data: {"choices":[{"delta":{"content":"Cline answer"}}]}\n\ndata: [DONE]\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rt = runtime();
    if (path === "ordinary") expect(await rt.execute("Review")).toMatchObject({ exitCode: 0, output: "Cline answer" });
    else expect(await rt.executeNative("Review", messages, tools)).toMatchObject({ stopReason: "end_turn", content: [{ type: "text", text: "Cline answer" }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("continues a Pass conversation after a tool result on the same connection", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, data: {
        choices: [{ message: { content: null, tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } }] }, finish_reason: "tool_calls" }],
      } }))
      .mockResolvedValueOnce(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    const rt = runtime();
    const first = await rt.executeNative("Review", messages, tools);
    expect(first.stopReason).toBe("tool_use");
    const result = await rt.executeNative("Review", [...messages,
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-read", content: "export const answer = 42;" }] },
    ], tools);
    expect(result.stopReason).toBe("end_turn");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://selected.example/api/v1/chat/completions");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-cline-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "cline-pass/glm-5.3", stream: false,
      messages: expect.arrayContaining([
        { role: "assistant", content: null, tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } }] },
        { role: "tool", tool_call_id: "call-read", content: "export const answer = 42;" },
      ]),
    });
  });

  it.each(["cline-pass/glm-5.3", "cline/anthropic/claude-sonnet-4-6", "cline/cline-pass/deepseek-v4-flash"])("uses its own key and preserves upstream model IDs for %s", async model => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    vi.stubGlobal("fetch", fetchMock);
    const rt = runtime(model);
    const result = await rt.executeNative("Review carefully", messages, []);
    expect(rt.resolvedProvider()).toBe("cline");
    expect(rt.resolvedModel()).toBe(model.replace(/^cline\//, ""));
    expect(result).toMatchObject({ content: [{ type: "text", text: "Cline answer" }], stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://selected.example/api/v1/chat/completions");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-cline-key");
    expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: model.replace(/^cline\//, ""), max_tokens: 8192 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses success/data tool calls and usage without changing the wire model", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, data: {
      ...completion, model: "z-ai/glm-5.3", choices: [{ message: { content: null, tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } }] }, finish_reason: "tool_calls" }],
    } }));
    vi.stubGlobal("fetch", fetchMock);
    const rt = runtime();
    expect(await rt.executeNative("Review", messages, tools)).toMatchObject({ content: [{ type: "tool_use", id: "call-read", name: "read_file", input: { path: "src/main.ts" } }], stopReason: "tool_use", usage: { inputTokens: 12, outputTokens: 4 } });
    expect(rt.resolvedModel()).toBe("cline-pass/glm-5.3");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).tools[0].function).toMatchObject({ name: "read_file", parameters: { type: "object", required: ["path"] } });
  });

  it("supports envelopes on ordinary execute as well as native calls", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, data: completion })));
    expect(await runtime().execute("Review source")).toMatchObject({ output: "Cline answer", exitCode: 0, usage: { inputTokens: 12, outputTokens: 4 } });
  });

  it.each([{ success: false, data: completion }, { success: true }, { success: true, data: [] }, { choices: [] }, { choices: [{ message: null }] }])("rejects malformed or unsuccessful Cline payloads instead of returning an empty successful turn", async body => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body)));
    expect(await runtime().executeNative("Review", messages, [])).toMatchObject({ stopReason: "error", error: expect.stringMatching(/Cline returned/) });
    expect(await runtime().execute("Review")).toMatchObject({ exitCode: 1, error: expect.stringMatching(/Cline returned/) });
  });

  it("does not unwrap a success/data envelope from another provider", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, data: completion })));
    const rt = new LlmApiRuntime({ type: "api", provider: "openai", model: "gpt-4o", timeout: 1000, env: { OPENAI_API_KEY: "synthetic-openai-key", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "" } });
    const result = await rt.executeNative("Review", messages, []);
    expect(result.content).not.toContainEqual({ type: "text", text: "Cline answer" });
  });

  it("requires the Cline connection's own nonblank credential", () => {
    expect(resolveFailoverProvider("cline", "cline-pass/glm-5.3", { OPENAI_API_KEY: "synthetic-other-key" })).toBeUndefined();
    expect(resolveFailoverProvider("cline", "cline-pass/glm-5.3", { CLINE_API_KEY: "   " })).toBeUndefined();
    expect(() => new LlmApiRuntime({ type: "api", provider: "cline", model: "cline-pass/glm-5.3", env: { CLINE_API_KEY: "", OPENAI_API_KEY: "synthetic-other-key", ZERO_SKIP_PROVIDER_BANNER: "1" } })).toThrow(/Cline model requires CLINE_API_KEY/);
  });

  it("routes an explicit ClinePass model ahead of other configured keys", () => {
    const rt = new LlmApiRuntime({ type: "api", model: "cline-pass/glm-5.3", env: { CLINE_API_KEY: "synthetic-cline-key", Z_AI_API_KEY: "synthetic-zai-key", ZERO_SKIP_PROVIDER_BANNER: "1" } });
    expect(rt.resolvedProvider()).toBe("cline");
    expect(rt.resolvedModel()).toBe("cline-pass/glm-5.3");
  });

  it("preserves Pass prefixes when switching model and forking", async () => {
    const rt = runtime();
    rt.reconfigure({ model: "cline/cline-pass/kimi-k3" });
    expect(rt.resolvedModel()).toBe("cline-pass/kimi-k3");
    const child = await rt.forkForSubagent(500);
    expect(child.resolvedModel()).toBe("cline-pass/kimi-k3");
    expect(child.resolvedProvider()).toBe("cline");
  });
});


it.each(["cline-pass/glm-5.3", "cline/anthropic/claude-sonnet-4-6"])("fails closed for %s without Cline auth even when other providers are configured", model => {
  expect(() => new LlmApiRuntime({ type: "api", model, env: { CLINE_API_KEY: "", OPENAI_API_KEY: "synthetic-other-key", OPENROUTER_API_KEY: "synthetic-other-router-key" } })).toThrow(/Cline model requires CLINE_API_KEY/);
  expect(() => new LlmApiRuntime({ type: "api", model, apiKey: "synthetic-ambiguous-key", env: { CLINE_API_KEY: "" } })).toThrow(/explicit Cline provider/);
  expect(() => new LlmApiRuntime({ type: "api", provider: "openai", model, env: { CLINE_API_KEY: "synthetic-key", OPENAI_API_KEY: "synthetic-other-key" } })).toThrow(/require the Cline provider/);
});
