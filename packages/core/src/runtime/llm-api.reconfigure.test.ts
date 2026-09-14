import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";

const environment = () => ({ "0SEC_FORCE_PROVIDER": "", "0SEC_SELECTED_PROVIDER": "", "0SEC_SKIP_PROVIDER_BANNER": "1", "0SEC_LLM_FALLBACK": "" });

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
  hostedCatalogPromise: Promise<void> | null;
  hostedMaxOutputTokens: number | undefined;
  config: { agentModels?: Readonly<Record<string, string>>; singleModel?: boolean; model?: string };
};
const peek = (runtime: LlmApiRuntime): Internals => runtime as unknown as Internals;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("live runtime reconfiguration", () => {
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

  it("re-detects the account and clears the hosted memo on a provider change", () => {
    const runtime = new LlmApiRuntime({
      type: "api", provider: "openai", model: "primary", timeout: 1000,
      env: { ...environment(), OPENAI_API_KEY: "openai-key", OPENAI_BASE_URL: "https://openai.fixture/v1" },
    });
    // Prime a stale hosted memo to prove reconfigure drops it.
    peek(runtime).hostedCatalogPromise = Promise.resolve();
    peek(runtime).hostedMaxOutputTokens = 999;

    runtime.reconfigure({
      provider: "hosted",
      env: { ...environment(), "0SEC_CLOUD_HOST": "http://127.0.0.1:12345", "0SEC_CLOUD_TOKEN": "cloud-token" },
    });

    const after = peek(runtime);
    expect(after.provider).toBe("hosted");
    expect(after.apiKey).toBe("cloud-token");
    expect(after.baseUrl).toContain("127.0.0.1:12345");
    // The old account's catalog ceiling must not survive the switch.
    expect(after.hostedCatalogPromise).toBeNull();
    expect(after.hostedMaxOutputTokens).toBeUndefined();
  });
});
