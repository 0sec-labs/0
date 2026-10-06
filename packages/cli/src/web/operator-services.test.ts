import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginsRootDir, readEnablement, LlmApiRuntime } from "@0/core";
import { saveSession, loadSession, type StoredSession } from "../tui/session-store.js";
import { PROVIDERS } from "../tui/provider-status.js";
import { applyWebConsoleRuntimeSelection, describeWebConsoleRuntime, savedWebRuntimeSelection, flushWebConsolePlugins, WebOperatorServices } from "./operator-services.js";

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

let testHome: string;
beforeEach(() => {
  execution.profile = "local"; execution.flush.mockClear();
  testHome = realpathSync(mkdtempSync(join(tmpdir(), "zero-operator-reasoning-")));
  vi.stubEnv("HOME", testHome);
  vi.stubEnv("ZERO_SKIP_PROVIDER_BANNER", "1");
  for (const info of PROVIDERS) for (const key of info.envVars) vi.stubEnv(key, undefined);
  for (const key of ["ZERO_MODEL", "ZERO_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_LLM_FALLBACK"]) vi.stubEnv(key, undefined);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-deepseek-key");
  vi.spyOn(LlmApiRuntime.prototype, "availableModelCatalog").mockImplementation(async function(this: LlmApiRuntime) {
    return [{ id: this.resolvedProvider() === "openai" ? "account-only-model" : "provider-only-model" }];
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(testHome, { recursive: true, force: true }); });

describe("web model connection inspection", () => {
  it.each(["gpt-6.1-sol", "gpt-4o"])("round-trips effective runtime selection for %s without undefined fields", model => {
    const runtime = new LlmApiRuntime({ type: "api", timeout: 300_000, provider: "openai", model });
    if (model === "gpt-6.1-sol") runtime.setReasoningEffort("high");
    const selection = savedWebRuntimeSelection({ reasoningEffort: "max" }, describeWebConsoleRuntime(runtime));
    expect(selection.reasoningEffort).toBe(model === "gpt-6.1-sol" ? "high" : undefined);
    if (model === "gpt-4o") expect(Object.hasOwn(selection, "reasoningEffort")).toBe(false);
    const stored: StoredSession = { id: "console-effort", savedAt: 1000, target: "", model, mode: "standard", cwd: "/fixture", messageCount: 0, preview: "", messages: [],
      consoleState: { version: 1, title: "Effort test", objective: "", usage: { inputTokens: 0, outputTokens: 0 },
        configuration: { target: "", role: "audit", runtime: selection }, lastOutcome: null, todos: null, workers: [], compaction: null, queuedMessages: [] } };
    expect(saveSession(stored, testHome)).toBe(true);
    expect(loadSession(stored.id, testHome)?.consoleState?.configuration?.runtime).toEqual(selection);
  });

  it("uses Azure's real deployment for readiness and guides incomplete setup", async () => {
    vi.stubEnv("AZURE_OPENAI_API_KEY", "synthetic-azure-key");
    vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://azure.fixture/v1");
    vi.stubEnv("AZURE_OPENAI_MODEL", "operator-deployment");
    const ready = await new WebOperatorServices().handle("/api/console/providers", "GET", undefined, new URLSearchParams());
    const rows = ready?.data as { providers: Array<{ id: string; diagnostics: { valid: boolean; message: string | null } }> };
    expect(rows.providers.find(row => row.id === "azure")?.diagnostics.valid).toBe(true);
    vi.stubEnv("AZURE_OPENAI_MODEL", "");
    const incomplete = await new WebOperatorServices().handle("/api/console/providers", "GET", undefined, new URLSearchParams());
    const next = incomplete?.data as typeof rows;
    expect(next.providers.find(row => row.id === "azure")?.diagnostics).toMatchObject({ valid: false, message: "Choose an Azure deployment model in Connections to finish setup." });
  });

  it("applies a supported effort atomically and rejects unsupported effort", async () => {
    const runtime = new LlmApiRuntime({ type: "api", timeout: 300_000, provider: "openai", model: "gpt-6.1-sol" });
    const snapshot = await applyWebConsoleRuntimeSelection(runtime, { reasoningEffort: "high" });
    expect(snapshot.reasoning).toEqual({ effort: "high", options: ["low", "medium", "high", "xhigh", "max"] });
    await expect(applyWebConsoleRuntimeSelection(runtime, { reasoningEffort: "none" })).rejects.toThrow("available thinking effort");
    expect(runtime.reasoningConfiguration()?.effort).toBe("high");
    const switched = await applyWebConsoleRuntimeSelection(runtime, { providerId: "deepseek", model: "deepseek-chat" });
    expect(switched.reasoning).toBeNull();
  });

  it("reports configured OpenAI credentials without requiring a chosen model", async () => {
    const result = await new WebOperatorServices().handle("/api/console/providers", "GET", undefined, new URLSearchParams());
    const data = result?.data as { providers: Array<{ id: string; configured: boolean; diagnostics: { valid: boolean; message: string | null } }> };
    expect(data.providers.find((provider) => provider.id === "openai")).toMatchObject({ configured: true, diagnostics: { valid: true, message: null } });
  });

  it("returns only account-discovered OpenAI models without requiring a chosen model", async () => {
    const result = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=openai"));
    const data = result?.data as { models: Array<{ provider: string }>; diagnostics: Array<{ providerId: string; message: string }> };
    expect(data.models).toEqual([expect.objectContaining({ id: "account-only-model", provider: "openai", source: "account" })]);
    expect(data.diagnostics.filter((diagnostic) => diagnostic.providerId === "openai")).toEqual([]);
  });

  it("discovers Azure deployment aliases before a deployment is selected and never copies OpenAI rows", async () => {
    vi.stubEnv("AZURE_OPENAI_API_KEY", "synthetic-azure-key");
    vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://azure.fixture/openai/v1");
    vi.stubEnv("AZURE_OPENAI_MODEL", "");
    vi.mocked(LlmApiRuntime.prototype.availableModelCatalog).mockResolvedValue([{ id: "production-chat" }]);
    const result = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=azure"));
    expect(result?.data).toMatchObject({ models: [{ id: "production-chat", provider: "azure", source: "account" }], diagnostics: [] });
    expect(vi.mocked(LlmApiRuntime.prototype.availableModelCatalog)).toHaveBeenCalledOnce();
  });

  it("reports discovery failure with no guessed or configured-model fallback", async () => {
    vi.stubEnv("AZURE_OPENAI_API_KEY", "synthetic-azure-key");
    vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://azure.fixture/openai/v1");
    vi.stubEnv("AZURE_OPENAI_MODEL", "unverified-deployment");
    vi.mocked(LlmApiRuntime.prototype.availableModelCatalog).mockRejectedValue(new Error("Deployment discovery unavailable"));
    const result = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=azure"));
    expect(result?.data).toMatchObject({ models: [], diagnostics: [{ providerId: "azure", message: "Deployment discovery unavailable" }] });
  });

  it("does not leak one provider's discovered model IDs into another connection", async () => {
    const result = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams());
    const data = result?.data as { models: Array<{ id: string; provider: string }> };
    expect(data.models).toEqual([
      expect.objectContaining({ id: "provider-only-model", provider: "deepseek" }),
      expect.objectContaining({ id: "account-only-model", provider: "openai" }),
    ]);
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

  it("saves an approved VM plugin for automatic guest loading without loading it on the host", async () => {
    execution.profile = "smolvm";
    const directory = join(pluginsRootDir(testHome), "fixture.scanner");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "plugin.json"), JSON.stringify({ id: "fixture.scanner", name: "Fixture", version: "1.0.0", tools: [{ name: "fixture_scan", description: "test", parameters: {}, capabilities: ["filesystem-read"] }] }));
    writeFileSync(join(directory, "plugin.js"), 'throw new Error("host execution forbidden");');
    const result = await new WebOperatorServices().handle("/api/console/plugins/enable", "POST", { id: "fixture.scanner", approved: true, version: "1.0.0", capabilities: ["filesystem-read"] }, new URLSearchParams());
    expect(result).toMatchObject({ status: 200, data: { ok: true, state: "enabled", message: expect.stringContaining("new SmolVM chats") } });
    expect(readEnablement(process.cwd(), testHome).enabled["fixture.scanner"]).toMatchObject({ version: "1.0.0", capabilities: ["filesystem-read"] });
    expect(execution.flush).not.toHaveBeenCalled();
  });

  it("allows VM approvals to reach installed-plugin validation without attempting host loading", async () => {
    execution.profile = "smolvm";
    const result = await new WebOperatorServices().handle("/api/console/plugins/enable", "POST", { id: "not-installed-fixture" }, new URLSearchParams());
    expect(result).toMatchObject({ status: 409, data: { code: "invalid_plugin" } });
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


it("shows ClinePass public inventory without implying active subscription entitlement", async () => {
  vi.stubEnv("CLINE_API_KEY", "synthetic-cline-key");
  vi.spyOn(LlmApiRuntime.prototype, "availableModelCatalog").mockResolvedValue([
    { id: "cline-pass/glm-5.3", source: "catalog" }, { id: "anthropic/claude-sonnet-4-6", source: "catalog" },
  ]);
  const service = new WebOperatorServices();
  const inventory = await service.handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=cline"));
  expect(inventory?.data).toMatchObject({ models: [
    { id: "cline-pass/glm-5.3", provider: "cline", source: "public-catalog", price: "ClinePass plan (access unverified)" },
    { id: "anthropic/claude-sonnet-4-6", provider: "cline", source: "public-catalog" },
  ] });
  const runtime = new LlmApiRuntime({ type: "api", provider: "openai", model: "gpt-4o", timeout: 1000 });
  const selected = await applyWebConsoleRuntimeSelection(runtime, { providerId: "cline", model: "cline-pass/glm-5.3" });
  expect(selected).toMatchObject({ providerId: "cline", model: "cline-pass/glm-5.3", configured: true });
});
