import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";

const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }];
const completion = (content: string) => Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const environment = () => ({ "ZERO_FORCE_PROVIDER": "", "ZERO_SELECTED_PROVIDER": "", "ZERO_SKIP_PROVIDER_BANNER": "1", "ZERO_LLM_FALLBACK": "" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isolated child runtimes", () => {
  it("inherits each parent's resolved route and credentials despite caller and ambient mutation", async () => {
    const azureEnv = { ...environment(), AZURE_OPENAI_API_KEY: "azure-original", AZURE_OPENAI_BASE_URL: "https://azure.fixture/openai/v1", AZURE_OPENAI_WIRE_API: "chat_completions" };
    const openaiEnv = { ...environment(), OPENAI_API_KEY: "openai-original", OPENAI_BASE_URL: "https://openai.fixture/v1" };
    const azure = new LlmApiRuntime({ type: "api", provider: "azure", model: "azure-model", timeout: 1000, env: azureEnv });
    const openai = new LlmApiRuntime({ type: "api", provider: "openai", model: "openai-model", timeout: 1000, env: openaiEnv });
    azureEnv.AZURE_OPENAI_API_KEY = "changed";
    openaiEnv.OPENAI_BASE_URL = "https://unexpected.fixture";
    vi.stubEnv("ZERO_FORCE_PROVIDER", "deepseek");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      if (url === "https://azure.fixture/openai/v1/chat/completions" && headers.get("api-key") === "azure-original" && body.model === "azure-model") return completion("azure accepted");
      if (url === "https://openai.fixture/v1/chat/completions" && headers.get("authorization") === "Bearer openai-original" && body.model === "openai-model") return completion("openai accepted");
      return Response.json({ error: "wrong account or route" }, { status: 401 });
    });
    const children = await Promise.all([azure.forkForSubagent(1000), openai.forkForSubagent(1000)]);
    const results = await Promise.all(children.map(child => child.executeNative("system", messages, [])));
    expect(results.map(result => result.content)).toEqual([[{ type: "text", text: "azure accepted" }], [{ type: "text", text: "openai accepted" }]]);
  });

  it("keeps child failures on the parent account while preserving the root's configured fallback", async () => {
    vi.stubEnv("ZERO_LLM_429_MAX_RETRIES", "0");
    const parent = new LlmApiRuntime({ type: "api", provider: "openai", model: "primary", timeout: 1000, env: { ...environment(), OPENAI_API_KEY: "primary-key", OPENAI_BASE_URL: "https://primary.fixture/v1", "ZERO_LLM_FALLBACK": "deepseek:secondary", DEEPSEEK_API_KEY: "secondary-key", DEEPSEEK_BASE_URL: "https://secondary.fixture/v1" } });
    const [first, second] = await Promise.all([parent.forkForSubagent(1000), parent.forkForSubagent(1000)]);
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.model === "primary" ? new Response("quota", { status: 429 }) : Response.json({ output_text: "fallback accepted" });
    });
    expect(await first!.execute("fixture")).toMatchObject({ exitCode: 1 });
    expect(first!.resolvedModel()).toBe("primary");
    expect(second!.resolvedModel()).toBe("primary");
    expect(parent.resolvedModel()).toBe("primary");
    expect(await parent.execute("fixture")).toMatchObject({ exitCode: 0, output: "fallback accepted" });
    expect(parent.resolvedModel()).toBe("secondary");
  });

  it("applies approved overrides before role routing, inherits unmapped roles, and forces single-model descendants", async () => {
    const config = { type: "api" as const, provider: "openai" as const, model: "parent", agentModels: { review: "review-model", work: "work-model" }, timeout: 1000, env: { ...environment(), OPENAI_API_KEY: "same-account", OPENAI_BASE_URL: "https://selection.fixture/v1", OPENAI_WIRE_API: "chat_completions" } };
    const parent = new LlmApiRuntime(config);
    const forced = new LlmApiRuntime({ ...config, singleModel: true });
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return completion(`executed ${body.model}`);
    });
    const selected = await parent.forkForSubagent(1000, { role: "review", model: "work-model" });
    const forcedChild = await forced.forkForSubagent(1000, { role: "review", model: "unapproved" });
    const children = [
      selected,
      await parent.forkForSubagent(1000, { role: "unknown" }),
      await parent.forkForSubagent(1000, { role: "toString" }),
      forcedChild,
      await selected.forkForSubagent(1000, { role: "review" }),
      await forcedChild.forkForSubagent(1000, { role: "work" }),
    ];
    const results = await Promise.all(children.map(child => child.executeNative("system", messages, [])));
    expect(results.map(result => result.content)).toEqual([
      [{ type: "text", text: "executed work-model" }],
      [{ type: "text", text: "executed parent" }],
      [{ type: "text", text: "executed parent" }],
      [{ type: "text", text: "executed parent" }],
      [{ type: "text", text: "executed review-model" }],
      [{ type: "text", text: "executed parent" }],
    ]);
  });

  it("reselects the child wire without changing the pinned provider or the parent's model", async () => {
    const parent = new LlmApiRuntime({
      type: "api", provider: "azure", model: "gpt-5.6-sol", timeout: 1000,
      agentModels: { review: "azure-chat" },
      env: { ...environment(), AZURE_OPENAI_API_KEY: "azure-account", AZURE_OPENAI_BASE_URL: "https://azure.fixture/openai/v1", AZURE_OPENAI_WIRE_API: "chat_completions", OPENAI_API_KEY: "unrelated-account" },
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (new Headers(init?.headers).get("api-key") !== "azure-account") return new Response(null, { status: 401 });
      const body = JSON.parse(String(init?.body));
      if (url === "https://azure.fixture/openai/v1/chat/completions" && body.model === "azure-chat") return completion("child chat accepted");
      if (url === "https://azure.fixture/openai/v1/responses" && body.model === "gpt-5.6-sol") {
        const events = [
          { type: "response.output_text.delta", delta: "parent responses accepted" },
          { type: "response.completed", response: {
            output: [{ type: "message", content: [{ type: "output_text", text: "parent responses accepted" }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          } },
        ];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 400 });
    });
    const child = await parent.forkForSubagent(1000, { role: "review" });
    expect(await child.executeNative("system", messages, [])).toMatchObject({ content: [{ type: "text", text: "child chat accepted" }] });
    expect(await parent.executeNative("system", messages, [])).toMatchObject({ content: [{ type: "text", text: "parent responses accepted" }] });
  });

  it("auto-routes an accessible model, refuses an unreachable one, and keeps fixed pins and singleModel unchanged", async () => {
    // Two providers configured (openai primary + anthropic). No Z_AI_API_KEY,
    // so any glm model is unreachable.
    const env = { ...environment(), OPENAI_API_KEY: "openai-key", OPENAI_BASE_URL: "https://openai.fixture/v1", ANTHROPIC_API_KEY: "anthropic-key" };
    const base = { type: "api" as const, provider: "openai" as const, model: "parent", timeout: 1000, env };

    // "auto" role: the orchestrator's selection.model is accepted because its
    // provider (anthropic) has creds. "auto" never becomes a real model id.
    const auto = new LlmApiRuntime({ ...base, agentModels: { review: "auto" } });
    const accessible = auto.accessibleModels();
    expect(accessible).toContain("parent");
    expect(accessible).toContain("gpt-4o");
    expect(accessible).toContain("claude-sonnet-4-6");
    expect(accessible).not.toContain("glm-5.3");

    const autoChild = await auto.forkForSubagent(1000, { role: "review", model: "claude-sonnet-4-6" });
    expect(autoChild.resolvedModel()).toBe("claude-sonnet-4-6");

    // Under auto, an unreachable model (no Z_AI_API_KEY) is still refused.
    await expect(auto.forkForSubagent(1000, { role: "review", model: "glm-5.3" })).rejects.toThrow("not reachable");

    // autoRoute flag auto-routes any UNMAPPED role the same way.
    const global = new LlmApiRuntime({ ...base, autoRoute: true });
    expect((await global.forkForSubagent(1000, { role: "anything", model: "claude-sonnet-4-6" })).resolvedModel()).toBe("claude-sonnet-4-6");

    // Non-auto role: an accessible-but-unpinned model is refused exactly as before.
    const pinned = new LlmApiRuntime({ ...base, agentModels: { review: "gpt-4o" } });
    await expect(pinned.forkForSubagent(1000, { role: "review", model: "claude-sonnet-4-6" })).rejects.toThrow("not operator-approved");

    // singleModel still forces the parent model even when the role is auto.
    const forced = new LlmApiRuntime({ ...base, singleModel: true, agentModels: { review: "auto" } });
    expect((await forced.forkForSubagent(1000, { role: "review", model: "claude-sonnet-4-6" })).resolvedModel()).toBe("parent");
  });

  it("cannot extend the parent request timeout", async () => {
    vi.useFakeTimers();
    const parent = new LlmApiRuntime({ type: "api", provider: "openai", model: "fixture", timeout: 25, env: { ...environment(), OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: "https://timeout.fixture/v1" } });
    const child = await parent.forkForSubagent(60_000);
    vi.stubGlobal("fetch", (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const pending = child.execute("fixture");
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toMatchObject({ exitCode: 1, timedOut: true });
  });
});
