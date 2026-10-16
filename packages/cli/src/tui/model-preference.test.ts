import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LlmApiRuntime, createConsoleRuntime } from "@0/core";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetSettingsStoreForTests, configureSettingsStore, getSettings } from "./settings-store.js";
import { createPreferredConsoleRuntime, saveAppliedModelPreference } from "./model-preference.js";

let isolated: { homeDir: string; restore: () => void };
let baseEnv: Record<string, string>;
beforeEach(() => {
  const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "0-model-preference-")));
  isolated = { homeDir, restore: () => rmSync(homeDir, { recursive: true, force: true }) };
  __resetSettingsStoreForTests();
  baseEnv = {
    HOME: homeDir,
    CODEX_HOME: join(homeDir, ".codex"),
    ZERO_CHATGPT_AUTH_FILE: join(homeDir, "no-codex-auth.json"),
    ZERO_OFFLINE: "1",
    ZERO_NO_TELEMETRY: "1",
  };
  configureSettingsStore({ homeDir: isolated.homeDir, projectDir: isolated.homeDir });
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetSettingsStoreForTests();
  isolated.restore();
});

it("retains a successfully applied provider/model across launches while CLI and environment choices win", async () => {
  const env = { ...baseEnv, DEEPSEEK_API_KEY: "synthetic-deepseek-account", OPENAI_API_KEY: "synthetic-openai-account" };
  const selected = createConsoleRuntime({ provider: "deepseek", model: "deepseek-operator-choice", env });
  expect(saveAppliedModelPreference(selected)).toBe(true);
  __resetSettingsStoreForTests();
  configureSettingsStore({ homeDir: isolated.homeDir, projectDir: isolated.homeDir });
  const restored = await createPreferredConsoleRuntime({ env });
  expect(restored.runtime.getConfigurationDiagnostics().provider).toBe("deepseek");
  expect(restored.runtime.resolvedModel()).toBe("deepseek-operator-choice");
  const cli = await createPreferredConsoleRuntime({ provider: "openai", model: "gpt-explicit-cli", env });
  expect(cli.runtime.getConfigurationDiagnostics().provider).toBe("openai");
  expect(cli.runtime.resolvedModel()).toBe("gpt-explicit-cli");
  const exported = await createPreferredConsoleRuntime({ env: { ...env, ZERO_SELECTED_PROVIDER: "openai", ZERO_MODEL: "gpt-explicit-env" } });
  expect(exported.runtime.getConfigurationDiagnostics().provider).toBe("openai");
  expect(exported.runtime.resolvedModel()).toBe("gpt-explicit-env");
});

it("does not reuse a saved or inherited model after switching connections", async () => {
  const env = { ...baseEnv, DEEPSEEK_API_KEY: "synthetic-account-a" };
  const original = createConsoleRuntime({ provider: "deepseek", model: "deepseek-account-a-choice", env });
  expect(saveAppliedModelPreference(original)).toBe(true);
  const switchedEnv = { ...env, DEEPSEEK_API_KEY: "synthetic-account-b" };
  const fresh = await createPreferredConsoleRuntime({ env: switchedEnv });
  expect(fresh.runtime.resolvedModel()).not.toBe("deepseek-account-a-choice");
  const inherited = await createPreferredConsoleRuntime(
    { env: switchedEnv, provider: "deepseek", model: original.resolvedModel() },
    { inheritedConnectionIdentity: original.connectionIdentity() },
  );
  expect(inherited.runtime.resolvedModel()).not.toBe("deepseek-account-a-choice");
  expect(getSettings().modelPreference?.model).toBe("deepseek-account-a-choice");
});

it("uses account recommendation for an unselected Codex launch but preserves its valid saved model", async () => {
  const env = { ...baseEnv, ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-account-token", ZERO_CHATGPT_ACCOUNT_ID: "synthetic-subscription-account" };
  vi.spyOn(LlmApiRuntime.prototype, "codexModelCatalog").mockResolvedValue([
    { id: "gpt-account-recommended", priority: 0 },
    { id: "gpt-account-selected", priority: 1 },
  ]);
  const fresh = await createPreferredConsoleRuntime({ env });
  expect(fresh.runtime.resolvedModel()).toBe("gpt-account-recommended");
  expect(getSettings().modelPreference).toBeNull();
  fresh.runtime.reconfigure({ model: "gpt-account-selected" });
  expect(saveAppliedModelPreference(fresh.runtime)).toBe(true);
  const restored = await createPreferredConsoleRuntime({ env });
  expect(restored.runtime.resolvedModel()).toBe("gpt-account-selected");
  const overridden = await createPreferredConsoleRuntime({ env: { ...env, ZERO_MODEL: "gpt-explicit-env" } });
  expect(overridden.runtime.resolvedModel()).toBe("gpt-explicit-env");
});

it("rejects an unconnected explicit provider without replacing the successful saved choice", async () => {
  const env = { ...baseEnv, DEEPSEEK_API_KEY: "synthetic-existing-account" };
  const selected = createConsoleRuntime({ provider: "deepseek", model: "deepseek-kept-choice", env });
  expect(saveAppliedModelPreference(selected)).toBe(true);
  await expect(createPreferredConsoleRuntime({ env, provider: "anthropic", model: "claude-unconnected-choice" })).rejects.toThrow(/no configured credentials/);
  expect(getSettings().modelPreference?.providerId).toBe("deepseek");
  expect(getSettings().modelPreference?.model).toBe("deepseek-kept-choice");
});

it("provider-only CLI and environment pins discover a model, then retain only their own saved account choice", async () => {
  const env = { ...baseEnv, ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-provider-pin-token", ZERO_CHATGPT_ACCOUNT_ID: "synthetic-provider-pin-account", DEEPSEEK_API_KEY: "synthetic-other-provider-key" };
  vi.spyOn(LlmApiRuntime.prototype, "codexModelCatalog").mockResolvedValue([
    { id: "gpt-account-recommended", priority: 0 },
    { id: "gpt-account-selected", priority: 1 },
  ]);
  const other = createConsoleRuntime({ provider: "deepseek", model: "deepseek-saved-choice", env });
  expect(saveAppliedModelPreference(other)).toBe(true);
  const cli = await createPreferredConsoleRuntime({ env, provider: "chatgpt-codex" });
  const exported = await createPreferredConsoleRuntime({ env: { ...env, ZERO_SELECTED_PROVIDER: "chatgpt-codex" } });
  expect(cli.runtime.resolvedModel()).toBe("gpt-account-recommended");
  expect(exported.runtime.resolvedModel()).toBe("gpt-account-recommended");
  expect(getSettings().modelPreference?.providerId).toBe("deepseek");
  cli.runtime.reconfigure({ model: "gpt-account-selected" });
  expect(saveAppliedModelPreference(cli.runtime)).toBe(true);
  expect((await createPreferredConsoleRuntime({ env, provider: "chatgpt-codex" })).runtime.resolvedModel()).toBe("gpt-account-selected");
  expect((await createPreferredConsoleRuntime({ env: { ...env, ZERO_SELECTED_PROVIDER: "chatgpt-codex" } })).runtime.resolvedModel()).toBe("gpt-account-selected");
});

it("does not infer access from a historical default when fresh account discovery fails", async () => {
  const env = { ...baseEnv, ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-denied-token", ZERO_CHATGPT_ACCOUNT_ID: "synthetic-denied-account" };
  const catalog = vi.spyOn(LlmApiRuntime.prototype, "codexModelCatalog").mockRejectedValue(new Error("Codex model discovery failed (HTTP 403)"));
  await expect(createPreferredConsoleRuntime({ env })).rejects.toThrow("HTTP 403");
  catalog.mockResolvedValue([]);
  await expect(createPreferredConsoleRuntime({ env })).rejects.toThrow("no available models");
  expect(getSettings().modelPreference).toBeNull();
});
