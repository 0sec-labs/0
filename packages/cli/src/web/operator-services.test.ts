import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmApiRuntime } from "@0/core";
import { saveSession, loadSession, type StoredSession } from "../tui/session-store.js";
import { PROVIDERS } from "../tui/provider-status.js";
import { applyWebConsoleRuntimeSelection, describeWebConsoleRuntime, savedWebRuntimeSelection, WebOperatorServices } from "./operator-services.js";

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
  testHome = realpathSync(mkdtempSync(join(tmpdir(), "zero-operator-reasoning-")));
  vi.stubEnv("HOME", testHome);
  vi.stubEnv("ZERO_SKIP_PROVIDER_BANNER", "1");
  for (const info of PROVIDERS) for (const key of info.envVars) vi.stubEnv(key, undefined);
  for (const key of ["ZERO_MODEL", "ZERO_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_LLM_FALLBACK"]) vi.stubEnv(key, undefined);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-deepseek-key");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(testHome, { recursive: true, force: true }); });

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
