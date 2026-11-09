import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, __resetFallbackChainForTests } from "./llm-api.js";
import type { CyberAccessProgram, RuntimeConfig } from "./types.js";
const base: RuntimeConfig = { type: "api", timeout: 1000, provider: "openai", model: "gpt-fixture", env: { OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_WIRE_API: "responses", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "" } };
const complete = (program?: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "response-fixture", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }], usage: { input_tokens: 2, output_tokens: 1 }, ...(program === undefined ? {} : { access_programs: { cyber: program } }) } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
beforeEach(() => { __resetFallbackChainForTests(); vi.stubGlobal("fetch", vi.fn(async () => complete())); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __resetFallbackChainForTests(); });
describe("public Responses cyber access program", () => {
  it.each(["standard", "daybreak_blue", "daybreak_red"] as CyberAccessProgram[])("sends explicit %s and retains confirmed response separately", async program => {
    const callback = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(complete(program));
    const runtime = new LlmApiRuntime({ ...base, cyberAccessProgram: program, onAccessProgram: callback });
    const result = await runtime.executeNative("Synthetic", [], []);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).access_programs).toEqual({ cyber: program });
    expect(result.accessProgram).toEqual({ requested: program, confirmed: program });
    expect(callback).toHaveBeenCalledWith(result.accessProgram);
  });
  it.each([undefined, null, "invalid"])("does not infer confirmation from success or invalid metadata %s", async program => {
    vi.mocked(fetch).mockResolvedValueOnce(complete(program));
    const result = await new LlmApiRuntime({ ...base, cyberAccessProgram: "daybreak_blue" }).executeNative("Synthetic", [], []);
    expect(result.accessProgram).toEqual({ requested: "daybreak_blue" });
  });
  it("retains the requested program on a provider access denial without fallback", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":{"code":"access_program_not_enabled"}}', { status: 403 }));
    const result = await new LlmApiRuntime({ ...base, cyberAccessProgram: "daybreak_red" }).executeNative("Synthetic", [], []);
    expect(result.stopReason).toBe("error"); expect(result.accessProgram).toEqual({ requested: "daybreak_red" }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains requested program on pre-dispatch cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await new LlmApiRuntime({ ...base, cyberAccessProgram: "standard" }).executeNative("Synthetic", [], [], undefined, controller.signal);
    expect(result.cancelled).toBe(true); expect(result.accessProgram).toEqual({ requested: "standard" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves selection and callback through a same-provider fork", async () => {
    const callback = vi.fn();
    const runtime = new LlmApiRuntime({ ...base, cyberAccessProgram: "daybreak_blue", onAccessProgram: callback });
    const child = await runtime.forkForSubagent(1000);
    await child.executeNative("Synthetic", [], []);
    expect(callback).toHaveBeenCalledWith({ requested: "daybreak_blue" });

  });
  it("sends the program and observes provider metadata through the legacy interface", async () => {
    const callback = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }], access_programs: { cyber: "standard" } })));
    await new LlmApiRuntime({ ...base, cyberAccessProgram: "standard", onAccessProgram: callback }).execute("Synthetic");
    expect(callback).toHaveBeenCalledWith({ requested: "standard", confirmed: "standard" });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).access_programs).toEqual({ cyber: "standard" });
  });
  it("does not leak a simultaneous request's confirmation into an absent receipt", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(complete("daybreak_red"));
    const runtime = new LlmApiRuntime({ ...base, cyberAccessProgram: "daybreak_blue" });
    const pending = runtime.executeNative("first", [], []);
    const other = await runtime.executeNative("second", [], []);
    finish(complete());
    expect(other.accessProgram).toEqual({ requested: "daybreak_blue", confirmed: "daybreak_red" });
    expect((await pending).accessProgram).toEqual({ requested: "daybreak_blue" });
  });
  it.each([
    { provider: undefined }, { provider: "openrouter" }, { provider: "chatgpt-plan" },
    { env: { ...base.env, OPENAI_BASE_URL: "https://proxy.example/v1" } },
    { env: { ...base.env, OPENAI_WIRE_API: "chat_completions" } },
  ] as Partial<RuntimeConfig>[])("rejects incompatible routing before fetch %j", config => {
    expect(() => new LlmApiRuntime({ ...base, ...config, cyberAccessProgram: "daybreak_blue" })).toThrow(/explicit OpenAI/); expect(fetch).not.toHaveBeenCalled();
  });
});


// Codex rust-v0.167.0 core/cyber_access_program.rs::for_auth explicitly forwards
// access_programs for ChatGPT auth; canonical backend is model-provider-info's
// CHATGPT_CODEX_BASE_URL. These tests use only synthetic token/account strings.
describe("canonical ChatGPT Codex subscription cyber selection", () => {
  const subscription: RuntimeConfig = { ...base, provider: "chatgpt-codex", env: {
    ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-access-token", ZERO_CHATGPT_ACCOUNT_ID: "synthetic-account",
    ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "",
  } };
  it.each(["standard", "daybreak_blue", "daybreak_red"] as CyberAccessProgram[])("sends %s with captured OAuth account and exact endpoint", async program => {
    vi.mocked(fetch).mockResolvedValueOnce(complete(program));
    const callback = vi.fn();
    const runtime = new LlmApiRuntime({ ...subscription, cyberAccessProgram: program, onAccessProgram: callback });
    const child = await runtime.forkForSubagent(1000);
    const result = await child.executeNative("Synthetic authorized source", [], []);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(JSON.parse(String(options?.body)).access_programs).toEqual({ cyber: program });
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe("Bearer synthetic-access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("synthetic-account");
    expect(result.accessProgram).toEqual({ requested: program, confirmed: program });
    expect(callback).toHaveBeenCalledWith(result.accessProgram);
  });
  it("retains request without claiming account entitlement when backend denies", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":{"code":"access_program_not_enabled"}}', { status: 403 }));
    const result = await new LlmApiRuntime({ ...subscription, cyberAccessProgram: "daybreak_blue" }).executeNative("Synthetic", [], []);
    expect(result.stopReason).toBe("error"); expect(result.accessProgram).toEqual({ requested: "daybreak_blue" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects an API-key credential on the explicit subscription route", () => {
    expect(() => new LlmApiRuntime({ ...subscription, apiKey: "synthetic-api-key", cyberAccessProgram: "daybreak_blue" })).toThrow(/explicit OpenAI/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("changes selection at an idle boundary without changing the captured account", async () => {
    const runtime = new LlmApiRuntime(subscription);
    expect(runtime.cyberAccessProgramConfiguration()).toEqual({ options: ["standard", "daybreak_blue", "daybreak_red"] });
    expect(fetch).not.toHaveBeenCalled();
    runtime.setCyberAccessProgram("daybreak_blue");
    expect(runtime.getCyberAccessProgram()).toBe("daybreak_blue");
    await runtime.executeNative("Synthetic", [], []);
    const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(headers.get("ChatGPT-Account-Id")).toBe("synthetic-account");
    runtime.setCyberAccessProgram(null);
    expect(runtime.getCyberAccessProgram()).toBeUndefined();
  });
  it("reports unsupported route without mutating a noncanonical connection", () => {
    const runtime = new LlmApiRuntime({ ...base, env: { ...base.env, OPENAI_BASE_URL: "https://proxy.example/v1" } });
    expect(runtime.cyberAccessProgramConfiguration()).toMatchObject({ options: [], unavailableReason: expect.any(String) });
    expect(() => runtime.setCyberAccessProgram("daybreak_blue")).toThrow(/canonical endpoint/);
    expect(runtime.getCyberAccessProgram()).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it("requires a captured account identity rather than selecting another account", () => {
    expect(() => new LlmApiRuntime({ ...subscription, env: { ...subscription.env, ZERO_CHATGPT_ACCOUNT_ID: "" }, cyberAccessProgram: "daybreak_blue" })).toThrow(/captured ChatGPT Codex OAuth account/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
