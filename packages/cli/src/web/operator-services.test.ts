import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginsRootDir, readEnablement, LlmApiRuntime } from "@0/engine";
import { saveSession, loadSession, type StoredSession } from "../state/session-store.js";
import { syncModelCatalog } from "../state/model-catalog-sync.js";
import * as nativePlanStore from "../state/chatgpt-plan-store.js";
import { createWebConsoleRuntime } from "./operator-services.js";
import { PROVIDERS } from "../state/provider-status.js";
import { applyWebConsoleRuntimeSelection, reloadWebConsoleRuntimeConnection, describeWebConsoleRuntime, savedWebRuntimeSelection, flushWebConsolePlugins, WebOperatorServices } from "./operator-services.js";

import { chooseWorkspaceFolder } from "./workspace-folder-picker.js";
vi.mock("./workspace-folder-picker.js", () => ({ chooseWorkspaceFolder: vi.fn(async () => ({ supported: false, path: null })) }));

const execution = vi.hoisted(() => ({ profile: "local" as "local" | "smolvm", flush: vi.fn(async () => []) }));
vi.mock("../console-execution.js", () => ({ consoleExecutionProfile: () => execution.profile }));
vi.mock("../state/plugin-service.js", async (original) => {
  const module = await original<typeof import("../state/plugin-service.js")>();
  return { ...module, createPluginService: (...args: Parameters<typeof module.createPluginService>) => ({ ...module.createPluginService(...args), flushDeferred: execution.flush }) };
});

vi.mock("../state/credential-store.js", async (original) => ({
  ...await original<typeof import("../state/credential-store.js")>(),
  loadCredentials: () => ({}), credentialEnvPatch: () => ({}),
  loadAccountStore: () => ({ providers: {} }), accountEnvPatch: () => ({}), listAccounts: () => [],
}));
vi.mock("../codex-auth.js", () => ({ maybeLoadCodexAuth: () => undefined }));
vi.mock("./connection-config.js", async (original) => ({
  ...await original<typeof import("./connection-config.js")>(),
  loadConnectionConfigs: () => ({}), connectionConfigEnvPatch: () => ({}),
}));
vi.mock("../state/settings-store.js", async (original) => ({
  ...await original<typeof import("../state/settings-store.js")>(),
  getSettings: () => ({ modelPreference: undefined }), updateSetting: () => true,
}));
vi.mock("../state/model-catalog-sync.js", async (original) => ({
  ...await original<typeof import("../state/model-catalog-sync.js")>(),
  syncModelCatalog: vi.fn(async () => undefined),
  loadCatalogModels: () => ({ fetchedAt: 0, source: "offline", models: [] }),
}));

let testHome: string;
beforeEach(() => {
  execution.profile = "local"; execution.flush.mockClear();
  vi.mocked(syncModelCatalog).mockReset().mockResolvedValue(null);
  testHome = realpathSync(mkdtempSync(join(tmpdir(), "zero-operator-reasoning-")));
  vi.stubEnv("HOME", testHome);
  vi.stubEnv("ZERO_SUPPRESS_PROVIDER_STARTUP_LOG", "1");
  for (const info of PROVIDERS) for (const key of info.envVars) vi.stubEnv(key, undefined);
  for (const key of ["ZERO_MODEL", "ZERO_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_LLM_FALLBACK", "OPENAI_MODEL"]) vi.stubEnv(key, undefined);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-deepseek-key");
  vi.spyOn(LlmApiRuntime.prototype, "availableModelCatalog").mockImplementation(async function(this: LlmApiRuntime) {
    return [{ id: this.resolvedProvider() === "openai" ? "account-only-model" : "provider-only-model" }];
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(testHome, { recursive: true, force: true }); });

describe("web model connection inspection", () => {
  it("uses captured Go context metadata for the active display without discovery and preserves an explicit limit", async () => {
    const { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap } = await import("./operator-services.js");
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "deepseek-v4.1-flash", env: {
      OPENAI_API_KEY: "synthetic-go-key", OPENAI_BASE_URL: "https://opencode.ai/inference/go/openai/v1", OPENAI_WIRE_API: "chat_completions", ZERO_LLM_FALLBACK: "",
    } });
    const discover = vi.spyOn(runtime, "availableModelCatalog");
    vi.stubEnv("OPENAI_BASE_URL", "https://other.example/v1");
    expect(describeWebConsoleRuntime(runtime).contextWindowTokens).toBe(1_000_000);
    expect(discover).not.toHaveBeenCalled();
    const bootstrap = captureWebConsoleRuntimeBootstrap(runtime);
    bootstrap.contextWindowTokens = 64_000;
    const restored = createWebConsoleRuntimeFromBootstrap(bootstrap);
    expect(restored.info.contextWindowTokens).toBe(64_000);
    expect(describeWebConsoleRuntime(restored.runtime).contextWindowTokens).toBe(64_000);
  });

  it("does not apply Go active-display metadata to another custom endpoint", () => {
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "deepseek-v4.1-flash", env: {
      OPENAI_API_KEY: "synthetic-other-key", OPENAI_BASE_URL: "https://other.example/v1", OPENAI_WIRE_API: "chat_completions", ZERO_LLM_FALLBACK: "",
    } });
    expect(runtime.publishedContextWindowTokens()).toBeUndefined();
    expect(describeWebConsoleRuntime(runtime).contextWindowTokens).toBe(128_000);
  });

  it("returns account rows while metadata refresh hangs, with one refresh per service", async () => {
    vi.mocked(syncModelCatalog).mockImplementation(() => new Promise(() => {}));
    const service = new WebOperatorServices();
    const first = await service.handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=openai"));
    const second = await service.handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=deepseek"));
    expect(first?.data).toMatchObject({ models: [{ id: "account-only-model", provider: "openai" }] });
    expect(second?.data).toMatchObject({ models: [{ id: "provider-only-model", provider: "deepseek" }] });
    expect(syncModelCatalog).toHaveBeenCalledOnce();
  });
  it("keeps successful account rows when another discovery ignores the full ten-second deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(LlmApiRuntime.prototype.availableModelCatalog).mockImplementation(async function(this: LlmApiRuntime) {
      if (this.resolvedProvider() === "deepseek") return new Promise(() => {});
      return [{ id: "verified-account-model" }];
    });
    const pending = new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams());
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false; void pending.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result?.data).toMatchObject({ models: [{ id: "verified-account-model", provider: "openai", source: "account" }], diagnostics: [{ providerId: "deepseek", message: "Model discovery timed out. Retry this connection." }] });
    expect((result?.data as { models: unknown[] }).models).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
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
    expect(data.providers.find((provider) => provider.id === "openai")).toMatchObject({ label: "OpenAI / Custom AI Provider", configured: true, diagnostics: { valid: true, message: null } });
  });

  it("scopes provider catalogs to opaque credentials and endpoint identity without leaking secrets", async () => {
    const service = new WebOperatorServices();
    const read = async () => {
      const result = await service.handle("/api/console/providers", "GET", undefined, new URLSearchParams());
      const data = result?.data as { providers: Array<{ id: string; connectionIdentity: string | null }> };
      expect(JSON.stringify(data)).not.toContain("synthetic-openai-key");
      return data.providers.find(provider => provider.id === "openai")!.connectionIdentity;
    };
    const original = await read();
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(await read()).toBe(original);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-replacement-key");
    const replaced = await read();
    expect(replaced).not.toBe(original);
    vi.stubEnv("OPENAI_BASE_URL", "https://gateway.fixture/custom/v1");
    expect(await read()).not.toBe(replaced);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await read()).toBeNull();
  });

  it("rejects a stale connection identity before model discovery or public catalog synchronization", async () => {
    const service = new WebOperatorServices();
    const metadata = await service.handle("/api/console/providers", "GET", undefined, new URLSearchParams());
    const { connectionIdentity } = (metadata!.data as { providers: Array<{ id: string; connectionIdentity: string }> }).providers.find(provider => provider.id === "openai")!;
    vi.stubEnv("OPENAI_API_KEY", "synthetic-new-account-key");
    vi.mocked(LlmApiRuntime.prototype.availableModelCatalog).mockClear();
    const rejected = await service.handle("/api/console/models", "GET", undefined, new URLSearchParams({ providerId: "openai", expectedConnectionIdentity: connectionIdentity }));
    expect(rejected).toMatchObject({ status: 409, data: { code: "model_connection_changed", error: "The model connection changed. Refresh Connections and try again." } });
    expect(LlmApiRuntime.prototype.availableModelCatalog).not.toHaveBeenCalled();
    expect(syncModelCatalog).not.toHaveBeenCalled();
    expect(JSON.stringify(rejected)).not.toContain("synthetic-new-account-key");
    const refreshed = await service.handle("/api/console/providers", "GET", undefined, new URLSearchParams());
    const current = (refreshed!.data as { providers: Array<{ id: string; connectionIdentity: string }> }).providers.find(provider => provider.id === "openai")!.connectionIdentity;
    expect(current).not.toBe(connectionIdentity);
    expect((await service.handle("/api/console/models", "GET", undefined, new URLSearchParams({ providerId: "openai", expectedConnectionIdentity: current })))?.status).toBe(200);
    // Older scoped callers and the global picker retain the existing contract.
    expect((await service.handle("/api/console/models", "GET", undefined, new URLSearchParams({ providerId: "openai" })))?.status).toBe(200);
    expect((await service.handle("/api/console/models", "GET", undefined, new URLSearchParams()))?.status).toBe(200);
  });

  it("explains an expired Codex model-discovery login without exposing its provider error body", async () => {
    vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "synthetic-codex-access");
    vi.mocked(LlmApiRuntime.prototype.availableModelCatalog).mockRejectedValue(new Error('ChatGPT Codex token refresh failed: 401 {"error":{"code":"refresh_token_expired","message":"private-provider-detail"}}'));
    const result = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=chatgpt-codex"));
    expect(result?.data).toMatchObject({ models: [], diagnostics: [{ providerId: "chatgpt-codex", message: expect.stringContaining("Reconnect ChatGPT / Codex in Connections") }] });
    expect(JSON.stringify(result?.data)).not.toContain("private-provider-detail");
    expect(JSON.stringify(result?.data)).toContain("codex login");
  });

  it("keeps a configured custom model selectable when gateway discovery fails", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://192.0.2.10:20128/v1");
    vi.stubEnv("OPENAI_MODEL", "9router/unlisted-model");
    vi.mocked(LlmApiRuntime.prototype.availableModelCatalog).mockRejectedValue(new Error("No model catalog"));
    const result = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=openai"));
    expect(result?.data).toMatchObject({ models: [{ id: "9router/unlisted-model", provider: "openai", source: "account" }] });
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


describe("explicit captured connection refresh", () => {
  it("uses current credentials without losing the selected model or reasoning", async () => {
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "gpt-6.1-sol", env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", OPENAI_API_KEY: "synthetic-old-key" }, agentModels: { review: "gpt-6.1-sol" } });
    runtime.setReasoningEffort("high"); const prior = runtime.connectionIdentity();
    const result = await reloadWebConsoleRuntimeConnection(runtime);
    expect(result).toMatchObject({ model: "gpt-6.1-sol", providerId: "openai", reasoning: { effort: "high" }, agentModels: { review: "gpt-6.1-sol" } });
    expect(result.connectionIdentity).not.toBe(prior);
    const expected = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "gpt-6.1-sol" });
    expect(result.connectionIdentity).toBe(expected.connectionIdentity());
  });
  it("retains the captured runtime if a fresh ChatGPT account cannot validate its catalog", async () => {
    vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "synthetic-reconnected-token"); vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "new-account");
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "chatgpt-codex", model: "gpt-6.1-sol", env: { ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-old-token", ZERO_CHATGPT_ACCOUNT_ID: "old-account", ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "" } });
    const prior = runtime.connectionIdentity();
    vi.spyOn(LlmApiRuntime.prototype, "codexModelCatalog").mockRejectedValue(new Error("Codex model discovery failed (HTTP 401)"));
    await expect(reloadWebConsoleRuntimeConnection(runtime)).rejects.toThrow("expired");
    expect(runtime.connectionIdentity()).toBe(prior); expect(runtime.resolvedModel()).toBe("gpt-6.1-sol");
  });
});


describe("read-only selected workspace metadata", () => {
  it("routes native selection through the operator service without applying session configuration", async () => {
    const service = new WebOperatorServices();
    vi.mocked(chooseWorkspaceFolder).mockResolvedValueOnce({ supported: true, path: testHome });
    expect(await service.handle("/api/console/project/choose-directory", "POST", { path: testHome }, new URLSearchParams())).toEqual({ status: 200, data: { supported: true, path: testHome } });
    expect(chooseWorkspaceFolder).toHaveBeenLastCalledWith(testHome);
    expect(await service.handle("/api/console/project/choose-directory", "GET", undefined, new URLSearchParams())).toMatchObject({ status: 405 });
    vi.mocked(chooseWorkspaceFolder).mockResolvedValueOnce({ supported: true, path: null });
    expect(await service.handle("/api/console/project/choose-directory", "POST", {}, new URLSearchParams())).toEqual({ status: 200, data: { supported: true, path: null } });
  });

  it("routes bounded folder browsing through the actual operator service without opening file contents", async () => {
    const project = join(testHome, "browse-workspace"); mkdirSync(project); mkdirSync(join(project, "child"));
    writeFileSync(join(project, "secret.txt"), "PRIVATE_FILE_CONTENT");
    const service = new WebOperatorServices();
    const result = await service.handle("/api/console/project/directories", "POST", { path: project }, new URLSearchParams());
    expect(result).toMatchObject({ status: 200, data: { path: project, entries: [{ name: "child", path: join(project, "child") }], truncated: false } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FILE_CONTENT");
    expect(await service.handle("/api/console/project/directories", "GET", undefined, new URLSearchParams())).toMatchObject({ status: 405 });
    expect(await service.handle("/api/console/project/directories", "POST", { path: project + "-missing" }, new URLSearchParams())).toMatchObject({ status: 400 });
  });
  it.skipIf(process.platform === "win32")("does not execute a repository fsmonitor hook when reading project metadata", async () => {
    const project = join(testHome, "selected-workspace");
    const marker = join(testHome, "fsmonitor-was-executed");
    const hook = join(testHome, "fsmonitor-hook.sh");
    mkdirSync(project);
    const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore", timeout: 5000 });
    git("init", "--quiet", project);
    writeFileSync(join(project, "README.md"), "Selected workspace fixture\n");
    git("-C", project, "add", "README.md");
    const quotedMarker = "'" + marker.replaceAll("'", "'\\''") + "'";
    writeFileSync(hook, `#!/bin/sh\nprintf observed > ${quotedMarker}\nprintf 'fixture-token\\0'\n`, { mode: 0o700 });
    git("-C", project, "config", "core.fsmonitor", hook);
    // Prove that this repository really invokes the hook without the protection.
    git("-C", project, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);

    const response = await new WebOperatorServices().handle("/api/console/project", "GET", undefined, new URLSearchParams({ path: project }));
    expect(response?.data).toMatchObject({ path: project, name: "selected-workspace", git: { root: project, dirty: true, error: null } });
    expect(existsSync(marker)).toBe(false);
  });
});


describe("local native ChatGPT operator boundary", () => {
  it("blocks hosted account metadata, discovery, login and mutation before touching the native store", async () => {
    const list = vi.spyOn(nativePlanStore, "listChatGptPlanProfiles").mockImplementation(() => { throw new Error("must not read local account"); });
    const login = vi.spyOn(nativePlanStore, "signInChatGptPlan").mockResolvedValue();
    const service = new WebOperatorServices({ allowChatGptPlan: false });
    const inventory = await service.handle("/api/console/providers", "GET", undefined, new URLSearchParams());
    expect(inventory?.status).toBe(200);
    expect((inventory?.data as { providers: Array<{ id: string }> }).providers.some(p => p.id === "chatgpt-plan")).toBe(false);
    for (const [path, method, body, query] of [
      ["/api/console/providers/chatgpt-plan", "GET", undefined, ""],
      ["/api/console/providers/chatgpt-plan/device-auth", "POST", {}, ""],
      ["/api/console/providers/chatgpt-plan/device-auth", "DELETE", {}, ""],
      ["/api/console/models", "GET", undefined, "providerId=chatgpt-plan"],
      ["/api/console/connections", "POST", { providerId: "chatgpt-plan", action: "activate", accountId: "p" }, ""],
    ] as const) expect(await service.handle(path, method, body, new URLSearchParams(query))).toMatchObject({ status: 403 });
    await expect(createWebConsoleRuntime({ providerId: "chatgpt-plan" }, { allowChatGptPlan: false })).rejects.toThrow(/local open-source/);
    expect(list).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled();
  });
  it("aborts native sign-in when the workspace operator is disposed and ignores late completion", async () => {
    vi.spyOn(nativePlanStore, "listChatGptPlanProfiles").mockReturnValue([]);
    let finish!: () => void, persisted = false;
    let signal: AbortSignal | undefined;
    vi.spyOn(nativePlanStore, "signInChatGptPlan").mockImplementation(async options => {
      signal = options.signal;
      await options.onAuthorize("https://auth.openai.com/oauth/authorize?state=fixture");
      await new Promise<void>(resolve => { finish = resolve; });
      options.signal?.throwIfAborted(); persisted = true;
    });
    const service = new WebOperatorServices();
    const started = await service.handle("/api/console/providers/chatgpt-plan/device-auth", "POST", {}, new URLSearchParams());
    expect(started).toMatchObject({ status: 202, data: { status: { phase: "running" } } });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    service.dispose(); expect(signal?.aborted).toBe(true);
    finish(); for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(persisted).toBe(false);
    const state = await service.handle("/api/console/providers/chatgpt-plan", "GET", undefined, new URLSearchParams());
    expect(state).toMatchObject({ data: { status: { phase: "cancelled", verificationUrl: null } } });
  });
  it("honors an explicit API provider over a stale native provider environment on hosted runtimes", async () => {
    vi.stubEnv("ZERO_SELECTED_PROVIDER", "chatgpt-plan");
    const result = await createWebConsoleRuntime({ providerId: "openai", model: "account-only-model" }, { allowChatGptPlan: false });
    expect(result.info.providerId).toBe("openai");
  });
  it("exposes only safe profile metadata and distinguishes identity-only consent", async () => {
    vi.spyOn(nativePlanStore, "listChatGptPlanProfiles").mockReturnValue([{ id: "p", label: "person@example.test", active: true, status: "connected", sharing: false }]);
    const result = await new WebOperatorServices().handle("/api/console/providers/chatgpt-plan", "GET", undefined, new URLSearchParams());
    expect(result).toMatchObject({ status: 200, data: { provider: { configured: true, diagnostics: { valid: false, reason: "plan_sharing_required" }, accounts: [{ accountId: "p", status: "connected", sharing: false }] } } });
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|idToken|clientId|hostId/);
  });
  it("signs out through its native store and reports unconfirmed remote revocation", async () => {
    vi.spyOn(nativePlanStore, "listChatGptPlanProfiles").mockReturnValue([]);
    const logout = vi.spyOn(nativePlanStore, "signOutChatGptPlan").mockResolvedValue({ revoked: false });
    const result = await new WebOperatorServices().handle("/api/console/connections", "POST", { providerId: "chatgpt-plan", action: "disconnect", accountId: "p" }, new URLSearchParams());
    expect(logout).toHaveBeenCalledWith("p");
    expect(result).toMatchObject({ status: 200, data: { revoked: false, message: expect.stringContaining("could not be confirmed") } });
  });
});

describe("private host worker runtime bootstrap", () => {
  it("captures the live account and settings despite ambient replacement and hydrates without auth discovery", async () => {
    const { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap } = await import("./operator-services.js");
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "gpt-6.1-sol", agentModels: { review: "gpt-6.1-sol" }, singleModel: true, env: { OPENAI_API_KEY: "fixture-account-a", OPENAI_BASE_URL: "https://provider-a.invalid/v1", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", NODE_OPTIONS: "fixture-do-not-forward", UNRELATED_SECRET: "fixture-private" } });
    runtime.setReasoningEffort("high");
    const identityA = runtime.connectionIdentity();
    vi.stubEnv("OPENAI_API_KEY", "fixture-account-b");
    vi.stubEnv("OPENAI_BASE_URL", "https://provider-b.invalid/v1");
    const bootstrap = captureWebConsoleRuntimeBootstrap(runtime);
    expect(bootstrap.binding.identity).toBe(identityA);
    expect(bootstrap.binding.env).not.toHaveProperty("NODE_OPTIONS");
    expect(bootstrap.binding.env).not.toHaveProperty("UNRELATED_SECRET");
    const restored = createWebConsoleRuntimeFromBootstrap(JSON.parse(JSON.stringify(bootstrap)));
    expect(restored.info).toMatchObject({ connectionIdentity: identityA, providerId: "openai", model: "gpt-6.1-sol", singleModel: true, agentModels: { review: "gpt-6.1-sol" }, reasoning: { effort: "high" } });
    expect(JSON.stringify(restored.info)).not.toContain("fixture-account-a");
    expect(JSON.stringify(restored.info)).not.toContain("provider-a.invalid");
    bootstrap.binding.apiKey = "fixture-mutated";
    expect(restored.runtime.connectionIdentity()).toBe(identityA);
  });

  it("captures explicit reconnect and provider reconfiguration rather than a stale bootstrap map", async () => {
    const { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap } = await import("./operator-services.js");
    const { runtime } = await createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol" });
    const initial = runtime.connectionIdentity();
    vi.stubEnv("OPENAI_API_KEY", "fixture-reconnected-key");
    await reloadWebConsoleRuntimeConnection(runtime);
    const reconnected = captureWebConsoleRuntimeBootstrap(runtime);
    expect(reconnected.binding.identity).not.toBe(initial);
    expect(createWebConsoleRuntimeFromBootstrap(reconnected).info.connectionIdentity).toBe(runtime.connectionIdentity());
    await applyWebConsoleRuntimeSelection(runtime, { providerId: "deepseek", model: "deepseek-v4-flash" });
    const switched = captureWebConsoleRuntimeBootstrap(runtime);
    expect(switched.binding.provider).toBe("deepseek");
    expect(createWebConsoleRuntimeFromBootstrap(switched).info.connectionIdentity).toBe(runtime.connectionIdentity());
  });

  it("preserves captured OAuth state and expiry without adopting a replacement account", async () => {
    const { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap } = await import("./operator-services.js");
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "chatgpt-codex", model: "gpt-6.1-sol", env: { ZERO_CHATGPT_ACCESS_TOKEN: "fixture-token-a", ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "fixture-refresh-a", ZERO_CHATGPT_ACCOUNT_ID: "fixture-account-a" } });
    const identity = runtime.connectionIdentity();
    vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "fixture-token-b");
    vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "fixture-account-b");
    const captured = captureWebConsoleRuntimeBootstrap(runtime);
    captured.contextWindowTokens = 123_456;
    const restored = createWebConsoleRuntimeFromBootstrap(captured);
    const roundtrip = captureWebConsoleRuntimeBootstrap(restored.runtime);
    expect(roundtrip.binding.codexAuthState).toEqual(captured.binding.codexAuthState);
    expect(restored.info.connectionIdentity).toBe(identity);
    expect(restored.info.contextWindowTokens).toBe(123_456);
    expect(JSON.stringify(restored.info)).not.toContain("fixture-token");
    expect(JSON.stringify(restored.info)).not.toContain("fixture-account");
  });

  it("accepts rotated tokens only for the same captured account and current model", async () => {
    const { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap, applyWebConsoleRuntimeBootstrap } = await import("./operator-services.js");
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "chatgpt-codex", model: "gpt-6.1-sol", env: { ZERO_CHATGPT_ACCESS_TOKEN: "fixture-original-access", ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "fixture-original-refresh", ZERO_CHATGPT_ACCOUNT_ID: "fixture-fixed-account" } });
    const child = createWebConsoleRuntimeFromBootstrap(captureWebConsoleRuntimeBootstrap(runtime)).runtime;
    const rotated = captureWebConsoleRuntimeBootstrap(child);
    rotated.binding.codexAuthState!.accessToken = "fixture-rotated-access";
    rotated.binding.codexAuthState!.refreshToken = "fixture-rotated-refresh";
    rotated.binding.codexAuthState!.accessTokenExpiresAt = 9_999_999_999_999;
    applyWebConsoleRuntimeBootstrap(runtime, rotated);
    expect(captureWebConsoleRuntimeBootstrap(runtime).binding.codexAuthState).toEqual(rotated.binding.codexAuthState);
    const other = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "chatgpt-codex", model: "gpt-6.1-sol", env: { ZERO_CHATGPT_ACCESS_TOKEN: "fixture-other-access", ZERO_CHATGPT_ACCOUNT_ID: "fixture-other-account" } });
    expect(() => applyWebConsoleRuntimeBootstrap(runtime, captureWebConsoleRuntimeBootstrap(other))).toThrow("current session");
    runtime.reconfigure({ model: "gpt-6.1-terra" });
    expect(() => applyWebConsoleRuntimeBootstrap(runtime, rotated)).toThrow("current session");
  });

  it("rejects altered identity and nonserializable granted transports", async () => {
    const { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap } = await import("./operator-services.js");
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "gpt-6.1-sol" });
    const bootstrap = captureWebConsoleRuntimeBootstrap(runtime);
    bootstrap.binding.identity = "fixture-wrong-identity";
    expect(() => createWebConsoleRuntimeFromBootstrap(bootstrap)).toThrow("identity");
    const granted = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "chatgpt-codex", model: "fixture-model", providerTransport: { provider: "chatgpt-codex", models: ["fixture-model"], identity: "fixture-grant", request: async () => new Response() } });
    expect(() => captureWebConsoleRuntimeBootstrap(granted)).toThrow("in-process transport");
  });
});


describe("explicit cyber program selection", () => {
  it("applies, saves and clears requested state without fabricating confirmation", async () => {
    vi.stubEnv("OPENAI_WIRE_API", "responses");
    const { runtime, info } = await createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" });
    expect(info.accessProgram).toMatchObject({ requested: "daybreak_blue", options: ["standard", "daybreak_blue", "daybreak_red"] });
    expect(info.accessProgram?.confirmed).toBeUndefined();
    const selection = savedWebRuntimeSelection({}, info);
    expect(selection.cyberAccessProgram).toBe("daybreak_blue");
    const stored: StoredSession = { id: "cyber-program", savedAt: 1, cwd: testHome, messageCount: 0, preview: "Program", messages: [], consoleState: { version: 1, title: "Program", objective: "", usage: { inputTokens: 0, outputTokens: 0 }, configuration: { target: "", role: "audit", runtime: selection }, lastOutcome: null, todos: null, workers: [], compaction: null, queuedMessages: [] } };
    expect(saveSession(stored, testHome)).toBe(true);
    expect(loadSession(stored.id, testHome)?.consoleState?.configuration?.runtime.cyberAccessProgram).toBe("daybreak_blue");
    await applyWebConsoleRuntimeSelection(runtime, { reasoningEffort: "high" });
    expect(runtime.getCyberAccessProgram()).toBe("daybreak_blue");
    const cleared = await applyWebConsoleRuntimeSelection(runtime, { cyberAccessProgram: null });
    expect(cleared.accessProgram?.requested).toBeNull();
    expect(savedWebRuntimeSelection({ cyberAccessProgram: "daybreak_blue" }, cleared).cyberAccessProgram).toBeNull();
  });
  it("rejects unsupported routes and retains the captured provider/account on failed changes", async () => {
    vi.stubEnv("OPENAI_WIRE_API", "responses");
    const { runtime } = await createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" });
    const identity = runtime.connectionIdentity();
    await expect(applyWebConsoleRuntimeSelection(runtime, { providerId: "deepseek", model: "deepseek-chat" })).rejects.toThrow(/Cyber access program/);
    expect(runtime.resolvedProvider()).toBe("openai");
    expect(runtime.connectionIdentity()).toBe(identity);
    expect(runtime.getCyberAccessProgram()).toBe("daybreak_blue");
    const changed = await applyWebConsoleRuntimeSelection(runtime, { providerId: "deepseek", model: "deepseek-chat", cyberAccessProgram: null });
    expect(changed.providerId).toBe("deepseek");
    expect(changed.accessProgram?.requested).toBeNull();
    await expect(createWebConsoleRuntime({ providerId: "deepseek", model: "deepseek-chat", cyberAccessProgram: "daybreak_red" })).rejects.toThrow(/Cyber access program/);
  });
});

it("exposes confirmation only after an actual owned response receipt and clears it on selection", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic-receipt", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }], usage: { input_tokens: 2, output_tokens: 1 }, access_programs: { cyber: "daybreak_blue" } } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
  const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "openai", model: "gpt-fixture", cyberAccessProgram: "daybreak_blue", env: { OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_WIRE_API: "responses", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_LLM_FALLBACK: "" } });
  expect(describeWebConsoleRuntime(runtime).accessProgram?.confirmed).toBeUndefined();
  await runtime.executeNative("Synthetic fixture only", [], []);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(describeWebConsoleRuntime(runtime).accessProgram?.confirmed).toBe("daybreak_blue");
  runtime.setCyberAccessProgram("daybreak_red");
  expect(describeWebConsoleRuntime(runtime).accessProgram).toMatchObject({ requested: "daybreak_red" });
  expect(describeWebConsoleRuntime(runtime).accessProgram?.confirmed).toBeUndefined();
});


it("binds a resumed cyber request to its saved connection before applying it", async () => {
  vi.stubEnv("OPENAI_WIRE_API", "responses");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-account-a");
  const selected = await createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" });
  const identity = selected.runtime.connectionIdentity()!;
  const resumed = await createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" }, { requiredProgramConnectionIdentity: identity });
  expect(resumed.runtime.getCyberAccessProgram()).toBe("daybreak_blue");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-account-b");
  await expect(createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" }, { requiredProgramConnectionIdentity: identity })).rejects.toThrow("different or unverified connection");
  await expect(createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" }, { requiredProgramConnectionIdentity: null })).rejects.toThrow("different or unverified connection");
  const cleared = await createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: null }, { requiredProgramConnectionIdentity: identity });
  expect(cleared.runtime.getCyberAccessProgram()).toBeUndefined();
  const reselected = await createWebConsoleRuntime({ providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" });
  expect(reselected.runtime.connectionIdentity()).not.toBe(identity);
});

it.each(["openai", "chatgpt-codex"] as const)("preserves explicit Daybreak in private %s bootstrap and forks without discovery or provider calls", async provider => {
  const { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap, applyWebConsoleRuntimeBootstrap } = await import("./operator-services.js");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("No provider calls permitted in private binding qualification"); });
  const env = { OPENAI_API_KEY: "synthetic-api-a", OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_WIRE_API: "responses", ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-oauth-a", ZERO_CHATGPT_ACCOUNT_ID: "synthetic-account-a", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_LLM_FALLBACK: "" };
  const selected = new LlmApiRuntime({ type: "api", timeout: 1000, provider, model: "gpt-fixture", cyberAccessProgram: "daybreak_blue", env });
  const captured = captureWebConsoleRuntimeBootstrap(selected);
  expect(captured.binding.config.cyberAccessProgram).toBe("daybreak_blue");
  vi.stubEnv("OPENAI_API_KEY", "ambient-unselected-key"); vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "ambient-unselected-account");
  const { runtime: worker, info } = createWebConsoleRuntimeFromBootstrap(captured);
  expect(worker.getCyberAccessProgram()).toBe("daybreak_blue");
  expect(captureWebConsoleRuntimeBootstrap(worker).binding.opencodeConversationId).toBe(captured.binding.opencodeConversationId);
  expect(info.connectionIdentity).toBe(selected.connectionIdentity());
  expect(info.accessProgram?.confirmed).toBeUndefined();
  const fork = await worker.forkForSubagent(1000);
  expect(fork.getCyberAccessProgram?.()).toBe("daybreak_blue");
  expect((fork as LlmApiRuntime).exportPrivateWorkerBinding().opencodeConversationId).not.toBe(captured.binding.opencodeConversationId);
  applyWebConsoleRuntimeBootstrap(selected, captureWebConsoleRuntimeBootstrap(worker));
  selected.setCyberAccessProgram("daybreak_red");
  expect(() => applyWebConsoleRuntimeBootstrap(selected, captured)).toThrow(/current session/);
  // Explicit parent authorization is a separate path from refresh handback.
  worker.applyPrivateWorkerBinding(captureWebConsoleRuntimeBootstrap(selected).binding, { replaceSelection: true });
  expect(worker.getCyberAccessProgram()).toBe("daybreak_red");
  selected.setCyberAccessProgram(null);
  worker.applyPrivateWorkerBinding(captureWebConsoleRuntimeBootstrap(selected).binding, { replaceSelection: true });
  expect(worker.getCyberAccessProgram()).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
