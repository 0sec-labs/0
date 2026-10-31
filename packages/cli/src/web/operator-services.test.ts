import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginsRootDir, readEnablement, LlmApiRuntime } from "@0/core";
import { saveSession, loadSession, type StoredSession } from "../tui/session-store.js";
import { syncModelCatalog } from "../tui/model-catalog-sync.js";
import * as nativePlanStore from "../tui/chatgpt-plan-store.js";
import { createWebConsoleRuntime } from "./operator-services.js";
import { PROVIDERS } from "../tui/provider-status.js";
import { applyWebConsoleRuntimeSelection, reloadWebConsoleRuntimeConnection, describeWebConsoleRuntime, savedWebRuntimeSelection, flushWebConsolePlugins, WebOperatorServices } from "./operator-services.js";

import { chooseWorkspaceFolder } from "./workspace-folder-picker.js";
vi.mock("./workspace-folder-picker.js", () => ({ chooseWorkspaceFolder: vi.fn(async () => ({ supported: false, path: null })) }));

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
  syncModelCatalog: vi.fn(async () => undefined),
  loadCatalogModels: () => ({ fetchedAt: 0, source: "offline", models: [] }),
}));

let testHome: string;
beforeEach(() => {
  execution.profile = "local"; execution.flush.mockClear();
  vi.mocked(syncModelCatalog).mockReset().mockResolvedValue(null);
  testHome = realpathSync(mkdtempSync(join(tmpdir(), "zero-operator-reasoning-")));
  vi.stubEnv("HOME", testHome);
  vi.stubEnv("ZERO_SKIP_PROVIDER_BANNER", "1");
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
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "gpt-6.1-sol", env: { ZERO_SKIP_PROVIDER_BANNER: "1", OPENAI_API_KEY: "synthetic-old-key" }, agentModels: { review: "gpt-6.1-sol" } });
    runtime.setReasoningEffort("high"); const prior = runtime.connectionIdentity();
    const result = await reloadWebConsoleRuntimeConnection(runtime);
    expect(result).toMatchObject({ model: "gpt-6.1-sol", providerId: "openai", reasoning: { effort: "high" }, agentModels: { review: "gpt-6.1-sol" } });
    expect(result.connectionIdentity).not.toBe(prior);
    const expected = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "openai", model: "gpt-6.1-sol" });
    expect(result.connectionIdentity).toBe(expected.connectionIdentity());
  });
  it("retains the captured runtime if a fresh ChatGPT account cannot validate its catalog", async () => {
    vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "synthetic-reconnected-token"); vi.stubEnv("ZERO_CHATGPT_ACCOUNT_ID", "new-account");
    const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, provider: "chatgpt-codex", model: "gpt-6.1-sol", env: { ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-old-token", ZERO_CHATGPT_ACCOUNT_ID: "old-account", ZERO_CHATGPT_OAUTH_REFRESH_TOKEN: "" } });
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
