import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "@0/core";
import { PROVIDERS } from "../tui/provider-status.js";
import { applyWebConsoleRuntimeSelection, flushWebConsolePlugins, WebOperatorServices } from "./operator-services.js";

const execution = vi.hoisted(() => ({ profile: "local" as "local" | "smolvm", flush: vi.fn(async () => []) }));
vi.mock("../console-execution.js", () => ({ consoleExecutionProfile: () => execution.profile }));
vi.mock("../tui/plugin-service.js", async (original) => {
  const module = await original<typeof import("../tui/plugin-service.js")>();
  return { ...module, createPluginService: (...args: Parameters<typeof module.createPluginService>) => ({ ...module.createPluginService(...args), flushDeferred: execution.flush }) };
});

vi.mock("../tui/credential-store.js", async (original) => ({
  ...await original<typeof import("../tui/credential-store.js")>(),
  loadCredentials: () => ({}), credentialEnvPatch: () => ({}),
  loadAccountStore: () => ({ providers: {} }), accountEnvPatch: () => ({}), listAccounts: () => [],
}));
vi.mock("../codex-auth.js", () => ({ maybeLoadCodexAuth: () => undefined }));
vi.mock("./connection-config.js", async (original) => ({
  ...await original<typeof import("./connection-config.js")>(),
  loadConnectionConfigs: () => ({}), connectionConfigEnvPatch: () => ({}),
}));
vi.mock("../tui/settings-store.js", async (original) => ({
  ...await original<typeof import("../tui/settings-store.js")>(),
  getSettings: () => ({ modelPreference: undefined }), updateSetting: () => true,
}));
vi.mock("../tui/model-catalog-sync.js", async (original) => ({
  ...await original<typeof import("../tui/model-catalog-sync.js")>(),
  syncModelCatalog: async () => undefined,
  loadCatalogModels: () => ({ fetchedAt: 0, source: "offline", models: [] }),
}));

beforeEach(() => {
  execution.profile = "local"; execution.flush.mockClear();
  for (const info of PROVIDERS) for (const key of info.envVars) vi.stubEnv(key, undefined);
  for (const key of ["ZERO_MODEL", "ZERO_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_LLM_FALLBACK"]) vi.stubEnv(key, undefined);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-deepseek-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("web model connection inspection", () => {
  it("reports configured OpenAI credentials without requiring a chosen model", async () => {
    const result = await new WebOperatorServices().handle("/api/console/providers", "GET", undefined, new URLSearchParams());
    const data = result?.data as { providers: Array<{ id: string; configured: boolean; diagnostics: { valid: boolean; message: string | null } }> };
    expect(data.providers.find((provider) => provider.id === "openai")).toMatchObject({ configured: true, diagnostics: { valid: true, message: null } });
  });

  it("returns OpenAI catalogue rows without a spurious explicit-model diagnostic", async () => {
    const result = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=openai"));
    const data = result?.data as { models: Array<{ provider: string }>; diagnostics: Array<{ providerId: string; message: string }> };
    expect(data.models.some((model) => model.provider === "openai")).toBe(true);
    expect(data.diagnostics.filter((diagnostic) => diagnostic.providerId === "openai")).toEqual([]);
  });

  it("applies the selected cross-provider model while retaining routing settings", async () => {
    const runtime = new LlmApiRuntime({ type: "api", timeout: 300_000, provider: "deepseek", model: "deepseek-chat", singleModel: true, autoRoute: true });
    const snapshot = await applyWebConsoleRuntimeSelection(runtime, { providerId: "openai", model: "gpt-6.1-sol" });
    expect(snapshot).toMatchObject({ providerId: "openai", model: "gpt-6.1-sol", singleModel: true, autoRoute: true, configured: true });
  });
});


describe("web isolated plugin boundaries", () => {
  it("rejects host plugin runs before reading installed plugin bytes while VM execution is selected", async () => {
    execution.profile = "smolvm";
    const result = await new WebOperatorServices().handle("/api/console/plugins/run", "POST", { id: "not-installed-fixture" }, new URLSearchParams());
    expect(result).toMatchObject({ status: 409, data: { code: "isolated_execution_required" } });
    expect(execution.flush).not.toHaveBeenCalled();
  });

  it("retains deferred host plugin work while VM execution is selected and flushes only in local mode", async () => {
    new WebOperatorServices();
    execution.profile = "smolvm";
    expect(await flushWebConsolePlugins()).toEqual([]);
    expect(execution.flush).not.toHaveBeenCalled();
    execution.profile = "local";
    expect(await flushWebConsolePlugins()).toEqual([]);
    expect(execution.flush).toHaveBeenCalledOnce();
  });
});
