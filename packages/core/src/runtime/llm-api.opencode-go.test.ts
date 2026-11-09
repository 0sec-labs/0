import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, __resetFallbackChainForTests } from "./llm-api.js";
import type { RuntimeConfig } from "./types.js";
const base: RuntimeConfig = { type: "api", timeout: 1000, provider: "openai", model: "glm-fixture", env: {
  OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: "https://opencode.ai/inference/go/openai/v1", OPENAI_WIRE_API: "chat_completions",
  ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "",
} };
const completion = () => new Response(JSON.stringify({ choices: [{ message: { content: "Done" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } });
const headers = (index: number) => new Headers(vi.mocked(fetch).mock.calls[index][1]?.headers);
beforeEach(() => { __resetFallbackChainForTests(); vi.stubGlobal("fetch", vi.fn(async () => completion())); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __resetFallbackChainForTests(); });
describe("OpenCode Go conversation routing", () => {
  it("sends a stable opaque session and its own user agent for legacy and native custom OpenAI requests", async () => {
    const runtime = new LlmApiRuntime(base);
    await runtime.execute("Synthetic source review");
    await runtime.executeNative("Synthetic source review", [], []);
    const id = headers(0).get("x-opencode-session");
    expect(id).toMatch(/^ses_[a-f0-9-]{36}$/);
    expect(headers(1).get("x-opencode-session")).toBe(id);
    expect(headers(0).get("User-Agent")).toMatch(/^0\//);
    expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe("error");
  });
  it.each(["https://opencode.ai/zen/go/v1", "https://opencode.ai/inference/go/openai/v1/"])("handles published Go base URL %s", async url => {
    await new LlmApiRuntime({ ...base, env: { ...base.env, OPENAI_BASE_URL: url } }).execute("Synthetic");
    expect(headers(0).get("x-opencode-session")).toMatch(/^ses_/);
  });
  it("supports Go configured under the OpenCode provider label", async () => {
    await new LlmApiRuntime({ ...base, provider: "opencode", model: "glm-5.3-flash", env: { OPENCODE_API_KEY: "synthetic", OPENCODE_BASE_URL: "https://opencode.ai/inference/go/openai/v1", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "" } }).execute("Synthetic");
    expect(headers(0).get("x-opencode-session")).toMatch(/^ses_/);
  });
  it("adds session headers on the Responses stream path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }], usage: { input_tokens: 2, output_tokens: 1 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const result = await new LlmApiRuntime({ ...base, env: { ...base.env, OPENAI_WIRE_API: "responses" } }).executeNative("Synthetic", [], []);
    expect(result.error).toBeUndefined(); expect(headers(0).get("x-opencode-session")).toMatch(/^ses_/);
  });
  it("separates independent conversations and isolated child transcripts", async () => {
    const parent = new LlmApiRuntime(base);
    const other = new LlmApiRuntime(base);
    const child = await parent.forkForSubagent(1000);
    await parent.execute("parent"); await other.execute("other"); await child.execute("child"); await child.execute("child again");
    expect(new Set([0, 1, 2].map(i => headers(i).get("x-opencode-session"))).size).toBe(3);
    expect(headers(3).get("x-opencode-session")).toBe(headers(2).get("x-opencode-session"));
  });
  it("keeps session affinity across an HTTP retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("unavailable", { status: 503, headers: { "retry-after": "0" } }));
    await new LlmApiRuntime(base).execute("Synthetic source review");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(headers(1).get("x-opencode-session")).toBe(headers(0).get("x-opencode-session"));
  });
  it.each(["https://api.openai.com/v1", "https://opencode.ai.evil.example/inference/go/openai/v1", "https://proxy.example/inference/go/openai/v1", "http://opencode.ai/inference/go/openai/v1", "https://opencode.ai/other/openai/v1", "https://opencode.ai:444/inference/go/openai/v1"])("does not send session identifiers to %s", async url => {
    await new LlmApiRuntime({ ...base, env: { ...base.env, OPENAI_BASE_URL: url } }).execute("Synthetic");
    expect(headers(0).has("x-opencode-session")).toBe(false);
  });
  it("removes Go-only headers when the same runtime is reconfigured to another endpoint", async () => {
    const runtime = new LlmApiRuntime(base);
    await runtime.execute("Go conversation");
    runtime.refreshConnection({ ...base.env, OPENAI_BASE_URL: "https://api.openai.com/v1" });
    await runtime.execute("OpenAI conversation");
    expect(headers(0).has("x-opencode-session")).toBe(true);
    expect(headers(1).has("x-opencode-session")).toBe(false);
  });
});

it("preserves actual Go wire affinity across private host moves and refresh handback while forks stay separate", async () => {
  const parent = new LlmApiRuntime(base);
  await parent.execute("Before process move");
  const worker = LlmApiRuntime.fromPrivateWorkerBinding(parent.exportPrivateWorkerBinding());
  await worker.executeNative("After process move", [], []);
  parent.applyPrivateWorkerBinding(worker.exportPrivateWorkerBinding());
  const replacement = LlmApiRuntime.fromPrivateWorkerBinding(parent.exportPrivateWorkerBinding());
  await replacement.execute("After forced process replacement");
  const child = await replacement.forkForSubagent(1000);
  await child.execute("Independent fork transcript");
  const original = headers(0).get("x-opencode-session");
  expect(original).toMatch(/^ses_[a-f0-9-]{36}$/);
  expect(headers(1).get("x-opencode-session")).toBe(original);
  expect(headers(2).get("x-opencode-session")).toBe(original);
  expect(headers(3).get("x-opencode-session")).not.toBe(original);
});
