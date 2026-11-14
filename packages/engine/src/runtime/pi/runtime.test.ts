import { describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { NativeMessage, NativeToolDef } from "../types.js";
import { createRuntime, createNativeApiRuntime, runtimeFromPrivateWorkerBinding, selectRuntimeKind, type ApiRuntime } from "../index.js";
import { PiAiRuntime, isPiRuntimeSelected } from "./runtime.js";
import { resolvePiRoute } from "./route.js";

const userMsg = (text: string): NativeMessage => ({ role: "user", content: [{ type: "text", text }] });
const tool: NativeToolDef = { name: "echo", description: "echo", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

function setup(opts: { tokensPerSecond?: number; timeout?: number } = {}) {
  const faux = fauxProvider(opts.tokensPerSecond ? { tokensPerSecond: opts.tokensPerSecond } : {});
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAiRuntime({ type: "api", timeout: opts.timeout ?? 5_000 }, { models, model: faux.getModel() });
  return { faux, runtime };
}

describe("PiAiRuntime.executeNative (faux pi provider, no network)", () => {
  it("returns text, usage and end_turn; streams deltas and usage to callbacks", async () => {
    const { faux, runtime } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("hello world")])]);
    const deltas: Array<[string, string]> = [];
    const onUsage = vi.fn();
    const result = await runtime.executeNative("sys", [userMsg("hi")], [], { onDelta: (s, t) => deltas.push([s, t]), onUsage });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every(([scope]) => scope === "assistant_response")).toBe(true);
    expect(deltas.map(([, t]) => t).join("")).toBe("hello world");
    expect(result.usage?.inputTokens).toBeGreaterThanOrEqual(0);
    expect(onUsage).toHaveBeenCalledTimes(result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0) ? 1 : 0);
    expect(result.cancelled).toBeUndefined();
  });

  it("maps tool calls to tool_use with stopReason tool_use, and thinking to onThinking/onDelta(reasoning) + providerRaw", async () => {
    const { faux, runtime } = setup();
    faux.setResponses([fauxAssistantMessage([fauxThinking("need echo"), fauxToolCall("echo", { text: "x" }, { id: "call_1" })], { stopReason: "toolUse" })]);
    const thinking: string[] = [];
    const reasoning: string[] = [];
    const result = await runtime.executeNative("sys", [userMsg("go")], [tool], { onThinking: (t) => thinking.push(t), onDelta: (s, t) => { if (s === "reasoning") reasoning.push(t); } });
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([{ type: "tool_use", id: "call_1", name: "echo", input: { text: "x" } }]);
    expect(thinking.join("")).toBe("need echo");
    expect(reasoning.join("")).toBe("need echo");
    expect(result.providerRaw?.provider).toBe("pi-ai:faux");
  });

  it("sends our history converted to pi (tool_result paired by name) on the next turn", async () => {
    const { faux, runtime } = setup();
    let seen: unknown;
    faux.setResponses([(context) => { seen = context.messages; return fauxAssistantMessage([fauxText("done")]); }]);
    const first: NativeMessage = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }] };
    const result = await runtime.executeNative("sys", [userMsg("go"), first, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }], [tool]);
    expect(result.stopReason).toBe("end_turn");
    const roles = (seen as Array<{ role: string }>).filter((m) => m.role !== "system").map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult"]);
  });

  it("max length maps to max_tokens", async () => {
    const { faux, runtime } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("trunc")], { stopReason: "length" })]);
    expect((await runtime.executeNative("", [userMsg("a")], [])).stopReason).toBe("max_tokens");
  });

  it("makes NO request when the signal is already aborted, and flags cancelled", async () => {
    const { faux, runtime } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("never")])]);
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.executeNative("", [userMsg("a")], [], undefined, controller.signal);
    expect(result.cancelled).toBe(true);
    expect(result.stopReason).toBe("error");
    expect(result.timedOut).toBeUndefined();
    expect(faux.state.callCount).toBe(0);
  });

  it("operator abort mid-stream is terminal: cancelled, not timed out, not retried", async () => {
    const { faux, runtime } = setup({ tokensPerSecond: 20 });
    faux.setResponses([fauxAssistantMessage([fauxText("a long response that streams slowly enough to cancel ".repeat(4))]), fauxAssistantMessage([fauxText("retry would land here")])]);
    const controller = new AbortController();
    const promise = runtime.executeNative("", [userMsg("a")], [], { onDelta: () => controller.abort() }, controller.signal);
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(faux.state.callCount).toBe(1);
  });

  it("our own timeout is timedOut, never cancelled", async () => {
    const { faux, runtime } = setup({ tokensPerSecond: 5, timeout: 50 });
    faux.setResponses([fauxAssistantMessage([fauxText("very slow ".repeat(50))])]);
    const result = await runtime.executeNative("", [userMsg("a")], []);
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBeUndefined();
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/timed out/);
  });

  it("maps a provider error to our error shape (non-retryable fails fast)", async () => {
    const { faux, runtime } = setup();
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid_request_error: bad tool schema" })]);
    const result = await runtime.executeNative("", [userMsg("a")], []);
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("API error: 400 invalid_request_error");
    expect(result.cancelled).toBeUndefined();
    expect(faux.state.callCount).toBe(1);
  });

  it("retries a transient error that produced no output, then succeeds", async () => {
    const { faux, runtime } = setup();
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable: overloaded" }),
      fauxAssistantMessage([fauxText("recovered")]),
    ]);
    const result = await runtime.executeNative("", [userMsg("a")], []);
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(faux.state.callCount).toBe(2);
  });

  it("legacy execute() returns text output", async () => {
    const { faux, runtime } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
    const out = await runtime.execute("ping", { systemPrompt: "s" });
    expect(out).toMatchObject({ output: "pong", exitCode: 0, timedOut: false });
  });
});

describe("PiAiRuntime over the real Anthropic wire with a mocked fetch", () => {
  const sse = (events: Array<[string, unknown]>): Response =>
    new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

  it("streams a tool call, normalises cache usage and sends the converted body", async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
      return sse([
        ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-test", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 20 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "echo", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"text\":" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"hi\"}" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    });
    const runtime = new PiAiRuntime(
      { type: "api", timeout: 5_000, provider: "anthropic", apiKey: "sk-ant-test-0123456789", model: "claude-sonnet-4-5", env: { ANTHROPIC_API_KEY: "", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } },
      { requestOptions: { fetch: fetchMock as unknown as typeof fetch } },
    );
    expect(await runtime.isAvailable()).toBe(true);
    const result = await runtime.executeNative("SYSTEM", [userMsg("hello")], [tool]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "echo", input: { text: "hi" } }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 12, cachedInputTokens: 90, cacheWriteTokens: 20 });
    expect(runtime.lastRequestCostUsd()).toBeGreaterThan(0);
    expect(JSON.stringify(body)).toContain("SYSTEM");
    expect((body?.tools as Array<{ name: string }>)[0]!.name).toBe("echo");
    expect(headers["x-api-key"]).toBe("sk-ant-test-0123456789");
    expect(runtime.resolvedProvider()).toBe("anthropic");
  });

  it("redacts the API key from provider error text and classifies as API error", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-secret-0123456789" } }), { status: 401, headers: { "content-type": "application/json" } }));
    const runtime = new PiAiRuntime(
      { type: "api", timeout: 5_000, provider: "anthropic", apiKey: "sk-ant-secret-0123456789", model: "claude-sonnet-4-5", env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } },
      { requestOptions: { fetch: fetchMock as unknown as typeof fetch, maxRetries: 0 } },
    );
    const result = await runtime.executeNative("", [userMsg("x")], []);
    expect(result.stopReason).toBe("error");
    expect(result.error).not.toContain("sk-ant-secret-0123456789");
    expect(result.error).toMatch(/Anthropic API error/);
  });
});

describe("request hooks and prompt-cache policy (pi transformHeaders / onPayload)", () => {
  it("applies transformHeaders and onPayload, and requests Anthropic prompt caching", async () => {
    let body: Record<string, unknown> = {};
    let headers = new Headers();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers as HeadersInit);
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "x", usage: { input_tokens: 1, output_tokens: 1 } } }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const onPayload = vi.fn(async () => undefined);
    const runtime = new PiAiRuntime(
      { type: "api", timeout: 5_000, provider: "anthropic", apiKey: "sk-ant-hook-0123456789", model: "claude-sonnet-4-5", env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } },
      { requestOptions: { fetch: fetchMock as unknown as typeof fetch, onPayload, transformHeaders: (h) => ({ ...h, "x-0-attribution": "scan-123" }) } },
    );
    await runtime.executeNative("SYSTEM PROMPT", [userMsg("hi")], [tool]);
    expect(headers.get("x-0-attribution")).toBe("scan-123");
    expect(onPayload).toHaveBeenCalled();
    expect(JSON.stringify(body)).toContain("cache_control");
  });
});

describe("route resolution and registry opt-in", () => {
  const cleanEnv = { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } as NodeJS.ProcessEnv;

  it("routes anthropic / openai / openrouter / google API keys and OpenAI-compatible base URLs", () => {
    expect(resolvePiRoute({ type: "api", timeout: 1, provider: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-4-5" }, cleanEnv))
      .toMatchObject({ piProvider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" });
    expect(resolvePiRoute({ type: "api", timeout: 1, provider: "openrouter", apiKey: "sk-or-x", model: "openrouter/anthropic/claude-sonnet-4.5" }, cleanEnv))
      .toMatchObject({ piProvider: "openrouter", api: "openai-completions", model: "anthropic/claude-sonnet-4.5" });
    expect(resolvePiRoute({ type: "api", timeout: 1, provider: "google", apiKey: "g-key", model: "gemini-2.5-flash" }, cleanEnv))
      .toMatchObject({ piProvider: "google", api: "google-generative-ai", apiKey: "g-key" });
    const compatEnv = { ...cleanEnv, OPENAI_API_KEY: "ollama", OPENAI_BASE_URL: "http://localhost:11434/v1" } as NodeJS.ProcessEnv;
    expect(resolvePiRoute({ type: "api", timeout: 1, provider: "openai", model: "llama3", env: compatEnv as Record<string, string> }, compatEnv))
      .toMatchObject({ piProvider: "openai-compat", api: "openai-completions", baseUrl: "http://localhost:11434/v1", model: "llama3" });
    const openaiEnv = { ...cleanEnv, OPENAI_API_KEY: "sk-x", OPENAI_WIRE_API: "responses" } as NodeJS.ProcessEnv;
    expect(resolvePiRoute({ type: "api", timeout: 1, provider: "openai", model: "gpt-5" }, openaiEnv)).toMatchObject({ piProvider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    // Default OpenAI wire is chat_completions; pi's built-in openai provider is Responses-only, so it rides the generic provider.
    expect(resolvePiRoute({ type: "api", timeout: 1, provider: "openai", model: "gpt-5" }, { ...cleanEnv, OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv))
      .toMatchObject({ piProvider: "openai-compat", api: "openai-completions" });
  });

  it("refuses OAuth/special providers instead of routing them silently", () => {
    for (const provider of ["chatgpt-codex", "copilot", "cline", "z-ai"] as const) {
      const env = { ...cleanEnv, ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "x", ZERO_COPILOT_GITHUB_TOKEN: "x", CLINE_API_KEY: "x", Z_AI_API_KEY: "x" } as NodeJS.ProcessEnv;
      expect(() => resolvePiRoute({ type: "api", timeout: 1, provider, apiKey: provider === "chatgpt-codex" ? undefined : "k", model: "m" }, env)).toThrow();
    }
    expect(() => resolvePiRoute({ type: "api", timeout: 1, provider: "openai", apiKey: "k", cyberAccessProgram: "standard" }, cleanEnv)).toThrow(/cyber access/);
  });

  it("an unusable route reports an error result and isAvailable() false instead of throwing", async () => {
    const runtime = new PiAiRuntime({ type: "api", timeout: 1, provider: "copilot", model: "m", env: { ZERO_COPILOT_GITHUB_TOKEN: "x" } });
    expect(await runtime.isAvailable()).toBe(false);
    const result = await runtime.executeNative("", [userMsg("a")], []);
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/does not support provider/);
  });

  it("flag parsing: only ZERO_RUNTIME=pi-ai opts in; config.env overrides process env", () => {
    expect(isPiRuntimeSelected({}, undefined)).toBe(false);
    expect(isPiRuntimeSelected({ ZERO_RUNTIME: "api" })).toBe(false);
    expect(isPiRuntimeSelected({ ZERO_RUNTIME: "pi-ai" })).toBe(true);
    expect(isPiRuntimeSelected({ ZERO_RUNTIME: "pi-ai" }, { ZERO_RUNTIME: "api" })).toBe(false);
  });

  it("the factory decides: pi-ai by default where it serves the route, legacy otherwise and via ZERO_RUNTIME=legacy", () => {
    const base = { type: "api" as const, timeout: 1, provider: "anthropic" as const, apiKey: "sk-ant-x", model: "claude-sonnet-4-5", env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } };
    const kind = (rt: unknown): string => (rt as ApiRuntime).implementation;
    expect(kind(createRuntime(base))).toBe("pi-ai");
    expect(kind(createNativeApiRuntime(base))).toBe("pi-ai");
    expect(kind(createNativeApiRuntime({ ...base, env: { ...base.env, ZERO_RUNTIME: "legacy" } }))).toBe("legacy");
    expect(kind(createNativeApiRuntime({ ...base, env: { ...base.env, ZERO_RUNTIME: "pi-ai" } }))).toBe("pi-ai");
    // Routes pi-ai does not serve stay on the legacy adapter even in the default mode.
    expect(kind(createNativeApiRuntime({ ...base, provider: "copilot", apiKey: "gho_x", model: "gpt-x" }))).toBe("legacy");
    expect(selectRuntimeKind({ ...base, provider: "openai", model: "gpt-5", cyberAccessProgram: "standard" })).toBe("legacy");
    // No usable credential: legacy keeps reporting its own diagnostics.
    expect(kind(createNativeApiRuntime({ type: "api", timeout: 1, env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } }))).toBe("legacy");
    expect(isPiRuntimeSelected({ ZERO_RUNTIME: "pi-ai" })).toBe(true);
  });

  it("reconfigure to another provider re-runs the factory decision and keeps the object identity", () => {
    const env = { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", OPENROUTER_API_KEY: "sk-or-0123456789", ZERO_COPILOT_GITHUB_TOKEN: "gho_0123456789" };
    const rt = createNativeApiRuntime({ type: "api", timeout: 1, provider: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-4-5", env });
    expect(rt.implementation).toBe("pi-ai");
    rt.reconfigure({ provider: "openrouter", model: "z-ai/glm-5.3-flash", env: env as NodeJS.ProcessEnv });
    expect(rt.implementation).toBe("pi-ai");
    expect(rt.resolvedProvider()).toBe("openrouter");
    rt.reconfigure({ provider: "copilot", model: "gpt-x", env: env as NodeJS.ProcessEnv });
    expect(rt.implementation).toBe("legacy");
    expect(rt.resolvedProvider()).toBe("copilot");
    rt.reconfigure({ provider: "openrouter", model: "z-ai/glm-5.3-flash", env: env as NodeJS.ProcessEnv });
    expect(rt.implementation).toBe("pi-ai");
  });

  it("selecting a cyber access program moves an OpenAI runtime to the legacy client (pi-ai cannot carry it); clearing keeps it there", () => {
    const env = { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", OPENAI_WIRE_API: "responses" };
    const rt = createNativeApiRuntime({ type: "api", timeout: 1, provider: "openai", apiKey: "sk-openai-0123456789", model: "gpt-6-luna", env });
    expect(rt.implementation).toBe("pi-ai");
    expect(rt.cyberAccessProgramConfiguration().options).toEqual([]);
    rt.setCyberAccessProgram("standard");
    expect(rt.implementation).toBe("legacy");
    expect(rt.getCyberAccessProgram()).toBe("standard");
    expect(rt.resolvedModel()).toBe("gpt-6-luna");
    rt.setCyberAccessProgram(null);
    expect(rt.getCyberAccessProgram()).toBeUndefined();
  });

  it("openai gpt-6+ models are upgraded to the Responses wire like the legacy client, so reasoning controls exist", () => {
    const rt = createNativeApiRuntime({ type: "api", timeout: 1, provider: "openai", apiKey: "sk-openai-0123456789", model: "gpt-6-luna", env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } });
    expect(rt.implementation).toBe("pi-ai");
    expect(rt.reasoningConfiguration()?.options).toContain("high");
    rt.setReasoningEffort("high");
    expect(rt.reasoningConfiguration()?.effort).toBe("high");
  });

  it("a worker binding round-trips on the implementation that exported it and preserves connection identity", () => {
    const env = { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" };
    const mk = (extra: Record<string, string>) => createNativeApiRuntime({ type: "api", timeout: 5_000, provider: "openrouter", apiKey: "sk-or-binding-0123456789", model: "z-ai/glm-5.3-flash", env: { ...env, ...extra } });
    for (const [mode, expected] of [["pi-ai", "pi-ai"], ["legacy", "legacy"]] as const) {
      const rt = mk({ ZERO_RUNTIME: mode });
      expect(rt.implementation).toBe(expected);
      const binding = rt.exportPrivateWorkerBinding();
      const worker = runtimeFromPrivateWorkerBinding(JSON.parse(JSON.stringify(binding)));
      expect(worker.implementation).toBe(expected);
      expect(worker.connectionIdentity()).toBe(rt.connectionIdentity());
      expect(worker.resolvedModel()).toBe("z-ai/glm-5.3-flash");
    }
    // Identity is the same hash across implementations, so saved preferences keep matching after the flip.
    expect(mk({ ZERO_RUNTIME: "pi-ai" }).connectionIdentity()).toBe(mk({ ZERO_RUNTIME: "legacy" }).connectionIdentity());
  });
});

describe("forkForSubagent / reconfigure", () => {
  it("fork keeps parent model, refuses unapproved models, allows operator-pinned role models", async () => {
    const faux = fauxProvider({ models: [{ id: "m-a" }, { id: "m-b" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const parent = new PiAiRuntime({ type: "api", timeout: 5_000, agentModels: { scout: "m-b" } }, { models, model: faux.getModel("m-a") });
    expect((await parent.forkForSubagent(1_000)).resolvedModel()).toBe("m-a");
    expect((await parent.forkForSubagent(1_000, { role: "scout" })).resolvedModel()).toBe("m-b");
    await expect(parent.forkForSubagent(1_000, { model: "m-zzz" })).rejects.toThrow(/not operator-approved/);
    await expect(parent.forkForSubagent(0)).rejects.toThrow(/positive finite/);
  });

  it("reconfigure updates the routing policy without a provider change", () => {
    const runtime = new PiAiRuntime({ type: "api", timeout: 1, provider: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-4-5", env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } });
    runtime.reconfigure({ singleModel: true, autoRoute: true, agentModels: { a: "claude-x" }, model: "claude-opus-4-5" });
    expect(runtime.modelSelection()).toEqual({ agentModels: { a: "claude-x" }, singleModel: true, autoRoute: true });
    expect(runtime.resolvedModel()).toBe("claude-opus-4-5");
  });

  it("ZERO_MAX_COMPLETION_TOKENS from config.env reaches both runtimes lazily", async () => {
    const { LlmApiRuntime } = await import("../llm-api/runtime.js");
    const base = { type: "api" as const, timeout: 1, provider: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-4-5" };
    const env = { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_MAX_COMPLETION_TOKENS: "777" };
    expect(new PiAiRuntime({ ...base, env }).outputTokenLimit).toBe(777);
    expect(new LlmApiRuntime({ ...base, env }).outputTokenLimit).toBe(777);
    const unset = { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" };
    expect(new PiAiRuntime({ ...base, env: unset }).outputTokenLimit).toBe(8192);
    expect(new LlmApiRuntime({ ...base, env: unset }).outputTokenLimit).toBe(8192);
  });
});
