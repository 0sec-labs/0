import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";
import { createWorkbenchProviderBroker } from "./workbench-provider-broker.js";

const environment = () => ({ "ZERO_FORCE_PROVIDER": "", "ZERO_SELECTED_PROVIDER": "", "ZERO_SKIP_PROVIDER_BANNER": "1", "ZERO_LLM_FALLBACK": "" });

// Reach past the type surface to assert the private route/selection state the
// live reconfiguration mutates in place — the same fields the constructor and
// fork branch write.
type Internals = {
  provider: string;
  model: string;
  wireApi: string;
  apiKey: string;
  baseUrl: string;
  reasoningEffort?: string;
  config: { agentModels?: Readonly<Record<string, string>>; singleModel?: boolean; model?: string };
};
const peek = (runtime: LlmApiRuntime): Internals => runtime as unknown as Internals;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("binds the host workbench credential closure to the selected account across ambient and runtime switches", async () => {
  vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "synthetic-broker-ambient-b");
  vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "broker-account-b");
  const runtime = new LlmApiRuntime({ type: "api", provider: "chatgpt-codex", model: "gpt-5.6-sol", env: {
    ...environment(), ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-broker-selected-a", ZERO_CHATGPT_ACCOUNT_ID: "broker-account-a",
    ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "",
  } });
  const resolveCredentials = runtime.workbenchCredentialResolver();
  vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "synthetic-broker-ambient-c");
  vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "broker-account-c");
  // An already-granted workspace must not inherit a later reconnect of the
  // original runtime object, either: the closure captures state, not `this`.
  runtime.reconfigure({ provider: "chatgpt-codex", env: {
    ...environment(), ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-broker-reconnected-b", ZERO_CHATGPT_ACCOUNT_ID: "broker-account-b",
    ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "",
  } });
  let calls = 0;
  const broker = createWorkbenchProviderBroker({ provider: "chatgpt-codex", models: ["gpt-5.6-sol"], resolveCredentials,
    fetchImpl: async (_url, options) => {
      calls++;
      const headers = new Headers(options?.headers);
      expect(headers.get("authorization")).toBe("Bearer synthetic-broker-selected-a");
      expect(headers.get("chatgpt-account-id")).toBe("broker-account-a");
      return new Response("data: captured account\n\n");
    },
  });
  try {
    expect(typeof resolveCredentials).toBe("function");
    expect(JSON.stringify(broker.grant)).not.toContain("synthetic-broker");
    for (let index = 0; index < 2; index++) {
      await (await broker.request({ provider: "chatgpt-codex", model: "gpt-5.6-sol",
        body: JSON.stringify({ model: "gpt-5.6-sol", instructions: "fixture", input: [], store: false, stream: true }),
      })).text();
    }
    expect(calls).toBe(2);
  } finally { await broker.close(); }
  const unsupported = new LlmApiRuntime({ type: "api", provider: "openai", env: { ...environment(), OPENAI_API_KEY: "fixture-api-key" } });
  expect(() => unsupported.workbenchCredentialResolver()).toThrow("captured chatgpt-codex account");
});

describe("live runtime reconfiguration", () => {
  it("inherits supported effort in same-model forks and resets it on model changes", async () => {
    const runtime = new LlmApiRuntime({ type: "api", provider: "openai", model: "gpt-6.1-sol", timeout: 1000,
      env: { ...environment(), OPENAI_API_KEY: "synthetic-key" } });
    runtime.setReasoningEffort("max");
    const fork = await runtime.forkForSubagent(1000);
    expect(fork.reasoningConfiguration()?.effort).toBe("max");
    expect(() => runtime.setReasoningEffort("none")).toThrow("not supported");
    runtime.reconfigure({ model: "gpt-6-luna" });
    expect(runtime.reasoningConfiguration()?.effort).toBe("medium");
    runtime.setReasoningEffort("none");
    expect(runtime.reasoningConfiguration()?.effort).toBe("none");
    runtime.reconfigure({ model: "gpt-4o" });
    expect(runtime.reasoningConfiguration()).toBeNull();
    expect(() => runtime.setReasoningEffort("high")).toThrow("not supported");
  });

  it("replaces the frozen agentModels map without touching provider or model", () => {
    const runtime = new LlmApiRuntime({
      type: "api", provider: "openai", model: "primary", timeout: 1000,
      agentModels: { review: "old-review" },
      env: { ...environment(), OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://openai.fixture/v1" },
    });
    const before = peek(runtime);
    const provider = before.provider;
    const model = before.model;
    const apiKey = before.apiKey;

    runtime.reconfigure({ agentModels: { review: "new-review", exploit: "new-exploit" }, singleModel: true });

    const after = peek(runtime);
    expect(after.config.agentModels).toEqual({ review: "new-review", exploit: "new-exploit" });
    expect(Object.isFrozen(after.config.agentModels)).toBe(true);
    expect(after.config.singleModel).toBe(true);
    // Provider / account / model are untouched — this only steers future forks.
    expect(after.provider).toBe(provider);
    expect(after.model).toBe(model);
    expect(after.apiKey).toBe(apiKey);
  });

  it("re-resolves model and wire for a same-provider model change", () => {
    const runtime = new LlmApiRuntime({
      type: "api", provider: "openai", model: "primary", timeout: 1000,
      env: { ...environment(), OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://openai.fixture/v1" },
    });
    expect(peek(runtime).wireApi).toBe("chat_completions");
    peek(runtime).reasoningEffort = "high";

    // gpt-5.6-luna on openai is the exact pair applyModelWireApi upgrades to
    // Responses — so a same-provider model change must re-run that resolution.
    runtime.reconfigure({ model: "gpt-5.6-luna" });

    const after = peek(runtime);
    expect(after.provider).toBe("openai");
    expect(after.model).toBe("gpt-5.6-luna");
    expect(after.config.model).toBe("gpt-5.6-luna");
    expect(after.wireApi).toBe("responses");
    // The fork modelChanged branch resets reasoning effort; reconfigure matches.
    expect(after.reasoningEffort).toBeUndefined();
  });

  it("re-detects the provider account and endpoint after a live switch", () => {
    const runtime = new LlmApiRuntime({
      type: "api", provider: "openai", model: "primary", timeout: 1000,
      env: { ...environment(), OPENAI_API_KEY: "openai-key", OPENAI_BASE_URL: "https://openai.fixture/v1" },
    });
    runtime.reconfigure({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      env: { ...environment(), DEEPSEEK_API_KEY: "deepseek-key", DEEPSEEK_BASE_URL: "https://deepseek.fixture/v1" },
    });
    const after = peek(runtime);
    expect(after.provider).toBe("deepseek");
    expect(after.apiKey).toBe("deepseek-key");
    expect(after.baseUrl).toBe("https://deepseek.fixture/v1");
    expect(after.model).toBe("deepseek-v4-flash");
  });

  it("retains same-provider picks but drops an omitted model on a provider-only reconnect", () => {
    vi.stubEnv("ZERO_MODEL", undefined);
    const runtime = new LlmApiRuntime({
      type: "api", provider: "openai", model: "operator-platform-model",
      env: { ...environment(), OPENAI_API_KEY: "synthetic-reconnect-platform" },
    });
    runtime.reconfigure({ singleModel: true });
    expect(runtime.resolvedModel()).toBe("operator-platform-model");
    const env = {
      ...environment(), DEEPSEEK_API_KEY: "synthetic-reconnect-deepseek",
      DEEPSEEK_BASE_URL: "https://deepseek.fixture/v1",
    };
    const fresh = new LlmApiRuntime({ type: "api", provider: "deepseek", env });
    runtime.reconfigure({ provider: "deepseek", env });
    expect(runtime.getConfigurationDiagnostics().provider).toBe("deepseek");
    expect(runtime.resolvedModel()).toBe(fresh.resolvedModel());
    expect(runtime.resolvedModel()).not.toBe("operator-platform-model");
  });
});


it("discovers and infers new models with one protocol on the captured subscription account", async () => {
  const env = { ...environment(), ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-account-a", ZERO_CHATGPT_ACCOUNT_ID: "account-a" };
  const runtime = new LlmApiRuntime({ type: "api", provider: "chatgpt-codex", model: "gpt-6.1", env });
  vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "synthetic-account-b");
  vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "account-b");
  let catalogVersion: string | undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.origin !== "https://chatgpt.com"
        || headers.get("Authorization") !== "Bearer synthetic-account-a"
        || headers.get("ChatGPT-Account-Id") !== "account-a") {
      return new Response(null, { status: 403 });
    }
    const version = headers.get("version") ?? "";
    const [major, minor] = version.split(".").map(Number);
    if (url.pathname.endsWith("/models")) {
      // The real backend hides GPT-6 models below Codex protocol 0.153.
      if (!(major > 0 || major === 0 && minor >= 153)
          || url.searchParams.get("client_version") !== version) {
        return Response.json({ models: [] });
      }
      catalogVersion = version;
      return Response.json({ models: [{ slug: "gpt-6.1" }] });
    }
    if (url.pathname !== "/backend-api/codex/responses"
        || version !== catalogVersion
        || headers.get("x-codex-routing-hint") !== "model=gpt-6.1"
        || JSON.parse(String(init?.body)).model !== "gpt-6.1") {
      return new Response(null, { status: 400 });
    }
    return new Response(`data: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "subscription reply" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  expect(await runtime.codexModelCatalog()).toEqual([{ id: "gpt-6.1" }]);
  const result = await runtime.executeNative("Reply briefly.", [{ role: "user", content: [{ type: "text", text: "Hello" }] }], []);
  expect(result.stopReason).toBe("end_turn");
  expect(result.content).toEqual([{ type: "text", text: "subscription reply" }]);
});

it("keeps saved connection identities account-scoped across token rotation and later login changes", () => {
  const codex = (accessToken: string, accountId?: string) => new LlmApiRuntime({
    type: "api", provider: "chatgpt-codex", model: "gpt-6.1",
    env: {
      ...environment(), ZERO_CHATGPT_ACCESS_TOKEN: accessToken,
      ZERO_CHATGPT_ACCOUNT_ID: accountId ?? "", ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "",
    },
  });
  const accountA = codex("synthetic-identity-token-a", "identity-account-a");
  const saved = accountA.connectionIdentity();
  expect(saved).toMatch(/^[a-f0-9]{64}$/);
  expect(codex("synthetic-identity-rotated-a", "identity-account-a").connectionIdentity()).toBe(saved);
  expect(codex("synthetic-identity-token-b", "identity-account-b").connectionIdentity()).not.toBe(saved);
  vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "identity-account-b");
  expect(accountA.connectionIdentity()).toBe(saved);
  expect(codex("synthetic-unidentified-a").connectionIdentity())
    .not.toBe(codex("synthetic-unidentified-b").connectionIdentity());
});

it("scopes Google preferences to the captured credential and effective project across access refreshes", () => {
  const google = (accessToken: string, refreshToken: string, project: string) => new LlmApiRuntime({
    type: "api", provider: "google", model: "gemini-2.5-pro",
    env: {
      ...environment(), ZERO_GEMINI_ACCESS_TOKEN: accessToken, ZERO_GEMINI_OAUTH_REFRESH_TOKEN: refreshToken,
      GOOGLE_CLOUD_PROJECT: project, ZERO_GEMINI_PROJECT: "lower-priority-project",
    },
  });
  const saved = google("synthetic-google-access-a", "synthetic-google-refresh-a", "project-a").connectionIdentity();
  expect(saved).toMatch(/^[a-f0-9]{64}$/);
  expect(google("synthetic-google-access-rotated", "synthetic-google-refresh-a", "project-a").connectionIdentity()).toBe(saved);
  expect(google("synthetic-google-access-a", "synthetic-google-refresh-a", "project-b").connectionIdentity()).not.toBe(saved);
  expect(google("synthetic-google-access-b", "synthetic-google-refresh-b", "project-a").connectionIdentity()).not.toBe(saved);
});
