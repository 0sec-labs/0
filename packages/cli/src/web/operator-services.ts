import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LlmApiRuntime, createConsoleRuntime, CodexCatalogRefreshError, DEFAULT_REGISTRY_URL,
  TOOL_DEFINITIONS, getToolsForRole, aggregateCapabilities, disable, readEnablement, writeEnablement,
  listInstalledPluginIds, pluginsRootDir, readInstalledPlugin, isSafePluginId,
  listProjectReviewChecks, updateProjectReviewChecks,
  type NativeRuntime, type RuntimeConfig, type ReviewCheckMutation,
} from "@0/core";
import { VERSION, modelProvider, type ConsoleRuntimeSelection, type ConsoleRuntimeSnapshot } from "@0/shared";
import {
  credentialEnvPatch, loadCredentials, accountEnvPatch, loadAccountStore, saveAccountStore,
  addAccount, removeAccount, logoutProvider, setActiveAccount, listAccounts,
} from "../tui/credential-store.js";
import { maybeLoadCodexAuth } from "../codex-auth.js";
import { PROVIDERS, providerStates } from "../tui/provider-status.js";
import { createPreferredConsoleRuntime, saveAppliedModelPreference } from "../tui/model-preference.js";
import { buildFullModelCatalog } from "../tui/model-catalog.js";
import { reachableModelCatalog } from "../tui/model-layout.js";
import { syncModelCatalog } from "../tui/model-catalog-sync.js";
import { resolveContextLimit } from "../tui/context-window.js";
import { startDeviceAuth, PROVIDER_DEVICE_AUTH, type DeviceAuthSession } from "../tui/device-auth.js";
import { getSettings, getSettingSources, updateSetting, resetSettings, defaultWriteLayer } from "../tui/settings-store.js";
import { DEFAULT_SETTINGS, SETTING_DEFS, isOperatorSetting, syncThemeChoices, type TuiSettings } from "../tui/settings.js";
import { allThemeNames, getThemeEntry, installedThemeEntries, reloadInstalledThemes, isKnownTheme } from "../tui/themes.js";
import { createPluginService, type PluginRunResult } from "../tui/plugin-service.js";
import { buildMarketItems, type MarketItem } from "../tui/market-layout.js";
import { createSessionPluginHostManager, type SessionPluginHostManager } from "../tui/session-plugin-host.js";
import { getRuntimeAvailability } from "../utils.js";
import { getRuntimeMetadata } from "../tui/runtime.js";
import { CodexAuthController, webAuthStatus, type WebAuthStatus } from "./codex-auth-controller.js";
import { connectionConfigEnvPatch, loadConnectionConfigs, saveConnectionConfig, validateConnectionConfig } from "./connection-config.js";
import { appendFeedback, buildSubmitPreview, submitFeedback, type FeedbackPayload, type SubmitPreview } from "../tui/feedback.js";

import { consoleExecutionProfile } from "../console-execution.js";

const MODEL_ROLES = ["discovery", "attack", "verify", "report", "audit", "review"];
const reservedToolNames = Object.values(TOOL_DEFINITIONS).map((tool) => tool.name);
const runtimeEnvironments = new WeakMap<LlmApiRuntime, Record<string, string>>();
const runtimeContextLimits = new WeakMap<LlmApiRuntime, number>();
let pluginManager: SessionPluginHostManager | undefined;
let pluginManagerPromise: Promise<SessionPluginHostManager> | undefined;
let isTurnActive: () => boolean = () => false;
const deferredPlugins = new Set<string>();

/** One approved marketplace host lineage. Sessions lease it, never hot-swap it. */
export async function getWebConsolePluginHostManager(): Promise<SessionPluginHostManager> {
  if (!pluginManagerPromise) {
    pluginManagerPromise = createSessionPluginHostManager({ reservedToolNames, coreVersion: VERSION })
      .then((manager) => { pluginManager = manager; return manager; })
      .catch((error) => { pluginManagerPromise = undefined; throw error; });
  }
  const manager = await pluginManagerPromise;
  await manager.refresh();
  return manager;
}

const pluginService = createPluginService({
  registryUrl: (process.env.ZERO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).trim(),
  reservedToolNames, coreVersion: VERSION, isTurnActive: () => isTurnActive(),
  pluginHostManager: {
    refresh: async () => { await (await getWebConsolePluginHostManager()).refresh(); },
    runPlugin: async (id) => (await getWebConsolePluginHostManager()).runPlugin(id),
  },
});

/** The gateway calls this only after its last active turn reaches a safe boundary. */
export async function flushWebConsolePlugins(): Promise<PluginRunResult[]> {
  if (consoleExecutionProfile() === "smolvm" || isTurnActive()) return [];
  const results = await pluginService.flushDeferred();
  deferredPlugins.clear();
  return results;
}

function webRuntimeEnv(): Record<string, string> {
  const env = { ...process.env };
  Object.assign(env, connectionConfigEnvPatch(env), credentialEnvPatch(loadCredentials(), env), accountEnvPatch(loadAccountStore(), env));
  maybeLoadCodexAuth({ env });
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Diagnostics may contain provider-controlled output; never echo an ambient/stored credential. */
function publicMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = new Set<string>();
  for (const provider of PROVIDERS) for (const variable of provider.envVars) {
    const value = process.env[variable];
    if (value) secrets.add(value);
  }
  for (const accounts of Object.values(loadAccountStore().providers)) for (const record of Object.values(accounts.accounts)) {
    if (record.kind === "api_key") secrets.add(record.secret);
    else for (const token of [record.tokens.accessToken, record.tokens.refreshToken]) if (token) secrets.add(token);
  }
  const env = { ...process.env };
  maybeLoadCodexAuth({ env });
  for (const variable of PROVIDERS.find((provider) => provider.id === "chatgpt-codex")!.envVars) if (env[variable]) secrets.add(env[variable]!);
  for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]");
  return message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/([?&](?:api[_-]?key|access_token|refresh_token|id_token|token|secret|password)=)[^&\s"'<>]+/gi, "$1[redacted]").slice(0, 4_000);
}

function runtimeDiagnostics(runtime: LlmApiRuntime) {
  const diagnostics = runtime.getConfigurationDiagnostics();
  return {
    valid: diagnostics.valid,
    reason: diagnostics.reason ?? null,
    message: diagnostics.fatalError ? publicMessage(diagnostics.fatalError) : null,
  };
}

/** Inspect connection configuration without choosing or requesting an inference model. */
function connectionProbeRuntime(providerId: string, env: Record<string, string>): LlmApiRuntime {
  return new LlmApiRuntime({
    type: "api", timeout: 300_000, provider: providerId as RuntimeConfig["provider"], env,
    // OpenAI has no default model. Like accessibleProviders(), use an explicit
    // sentinel solely for auth/transport inspection. Azure must still validate
    // its real deployment configuration; the probe cannot supply that for it.
    ...(providerId !== "azure" ? { model: "probe" } : {}),
  });
}

export function describeWebConsoleRuntime(runtime: NativeRuntime): ConsoleRuntimeSnapshot {
  const providerId = runtime.resolvedProvider?.() ?? "unknown";
  const model = runtime.resolvedModel?.() ?? "unknown";
  const api = runtime instanceof LlmApiRuntime ? runtime : undefined;
  const diagnostics = api ? runtimeDiagnostics(api) : { valid: true, reason: null, message: null };
  return {
    providerId, providerLabel: PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId,
    model, configured: diagnostics.valid, reasoning: api?.reasoningConfiguration() ?? null,
    connectionIdentity: api?.connectionIdentity() ?? null,
    diagnostics, ...(runtime.modelSelection?.() ?? { agentModels: {}, singleModel: false, autoRoute: false }),
    contextWindowTokens: (api ? runtimeContextLimits.get(api) : undefined) ?? resolveContextLimit({ modelId: model, providerId })?.tokens ?? null,
  };
}

type StoredReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
/** Persist only an effective effort, without stale or undefined optional fields. */
export function savedWebRuntimeSelection(selection: ConsoleRuntimeSelection, info: ConsoleRuntimeSnapshot | null): Omit<ConsoleRuntimeSelection, "reasoningEffort"> & { reasoningEffort?: StoredReasoningEffort } {
  const { reasoningEffort: selectedEffort, ...stored } = selection;
  const effort = info ? info.reasoning?.effort : selectedEffort;
  const reasoning = effort && ["none", "low", "medium", "high", "xhigh", "max"].includes(effort)
    ? { reasoningEffort: effort as StoredReasoningEffort } : {};
  if (!info) return { ...stored, ...reasoning };
  return { ...stored, providerId: info.providerId, model: info.model, agentModels: info.agentModels,
    singleModel: info.singleModel, autoRoute: info.autoRoute, ...reasoning,
  };
}

function validateSelection(selection: ConsoleRuntimeSelection): void {
  if (selection.providerId !== undefined && !PROVIDERS.some((provider) => provider.id === selection.providerId)) throw new OperatorError(400, "invalid_provider", "Unsupported provider.");
  for (const value of [selection.model, ...Object.values(selection.agentModels ?? {})]) {
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value))) throw new OperatorError(400, "invalid_model", "Model identifiers must be non-empty and contain no whitespace.");
  }
  if (selection.reasoningEffort !== undefined && !["none", "low", "medium", "high", "xhigh", "max"].includes(selection.reasoningEffort)) throw new OperatorError(400, "invalid_reasoning_effort", "Choose an available thinking effort.");
  for (const key of Object.keys(selection.agentModels ?? {})) if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) throw new OperatorError(400, "invalid_role", "Invalid model role.");
}

async function validateRuntimeModels(runtime: LlmApiRuntime): Promise<void> {
  const diagnostics = runtime.getConfigurationDiagnostics();
  if (!diagnostics.valid) throw new OperatorError(409, "provider_not_ready", publicMessage(diagnostics.fatalError ?? "Connect the selected provider first."));
  if (diagnostics.provider === "chatgpt-codex") {
    let models;
    try { models = await runtime.codexModelCatalog(AbortSignal.timeout(10_000)); }
    catch (error) {
      if (error instanceof CodexCatalogRefreshError) models = [...error.cachedModels];
      else if (/Codex model discovery failed \(HTTP 401\)/.test(error instanceof Error ? error.message : String(error))) throw new OperatorError(409, "connection_expired", "Your ChatGPT connection has expired or was rejected. Sign in again in Connections, then retry.");
      else throw error;
    }
    const selected = models.find((model) => model.id === runtime.resolvedModel());
    if (!selected) throw new OperatorError(409, "model_not_available", "The selected model is not available to this ChatGPT account.");
    if (selected.contextTokens) runtimeContextLimits.set(runtime, selected.contextTokens);
    for (const model of Object.values(runtime.modelSelection().agentModels)) {
      if (model !== "auto" && !models.some((entry) => entry.id === model.replace(/^openai\//, ""))) throw new OperatorError(409, "model_not_available", "A role model is not available to this ChatGPT account.");
    }
  }
  for (const role of Object.keys(runtime.modelSelection().agentModels)) {
    if (runtime.modelSelection().agentModels[role] !== "auto") await runtime.forkForSubagent(120_000, { role });
  }
}

export async function createWebConsoleRuntime(selection: ConsoleRuntimeSelection = {}): Promise<{ runtime: LlmApiRuntime; info: ConsoleRuntimeSnapshot }> {
  validateSelection(selection);
  const env = webRuntimeEnv();
  const { runtime } = await createPreferredConsoleRuntime({
    provider: selection.providerId as RuntimeConfig["provider"], model: selection.model,
    agentModels: selection.agentModels, singleModel: selection.singleModel, autoRoute: selection.autoRoute, env,
  });
  await validateRuntimeModels(runtime);
  if (selection.reasoningEffort !== undefined) {
    try { runtime.setReasoningEffort(selection.reasoningEffort); }
    catch { throw new OperatorError(400, "unsupported_reasoning_effort", "Choose an available thinking effort for this model."); }
  }
  runtimeEnvironments.set(runtime, env);
  if (selection.model !== undefined) saveAppliedModelPreference(runtime);
  return { runtime, info: describeWebConsoleRuntime(runtime) };
}

export async function applyWebConsoleRuntimeSelection(runtime: LlmApiRuntime, selection: ConsoleRuntimeSelection): Promise<ConsoleRuntimeSnapshot> {
  validateSelection(selection);
  const currentProvider = runtime.resolvedProvider();
  let providerId = selection.providerId;
  if (providerId === undefined && selection.model !== undefined) {
    const inferred = modelProvider(selection.model);
    if (inferred !== "unknown" && inferred !== currentProvider && !(currentProvider === "chatgpt-codex" && inferred === "openai")) providerId = inferred;
  }
  const targetProvider = providerId ?? currentProvider;
  let candidate: LlmApiRuntime;
  if (targetProvider !== currentProvider) {
    const env = webRuntimeEnv();
    const created = await createPreferredConsoleRuntime({
      provider: targetProvider as RuntimeConfig["provider"], model: selection.model, env,
      ...runtime.modelSelection(), ...selection,
    });
    candidate = created.runtime;
    await validateRuntimeModels(candidate);
    runtimeEnvironments.set(candidate, env);
  } else {
    // Fork captures this live connection, not freshly replaced account credentials.
    candidate = await runtime.forkForSubagent(120_000);
    candidate.reconfigure({ ...runtime.modelSelection(), ...selection });
    await validateRuntimeModels(candidate);
  }
  if (selection.reasoningEffort !== undefined) {
    try { candidate.setReasoningEffort(selection.reasoningEffort); }
    catch { throw new OperatorError(400, "unsupported_reasoning_effort", "Choose an available thinking effort for this model."); }
  }
  runtime.reconfigure({
    model: candidate.resolvedModel(), provider: targetProvider,
    ...candidate.modelSelection(),
    ...(targetProvider !== currentProvider ? { env: runtimeEnvironments.get(candidate) } : {}),
  });
  const reasoning = candidate.reasoningConfiguration();
  if (reasoning) runtime.setReasoningEffort(reasoning.effort);
  const contextTokens = runtimeContextLimits.get(candidate);
  if (contextTokens) runtimeContextLimits.set(runtime, contextTokens);
  else runtimeContextLimits.delete(runtime);
  if (selection.model !== undefined) saveAppliedModelPreference(runtime);
  return describeWebConsoleRuntime(runtime);
}

class OperatorError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OperatorError(400, "invalid_input", "Expected a JSON object.");
  return input as Record<string, unknown>;
}
function text(input: unknown, name: string, max = 4_096): string {
  if (typeof input !== "string" || !input.trim() || input.length > max || /[\x00]/.test(input)) throw new OperatorError(400, "invalid_input", `Invalid ${name}.`);
  return input.trim();
}
function provider(input: unknown) {
  const id = input === "codex" ? "chatgpt-codex" : text(input, "provider", 64);
  const result = PROVIDERS.find((entry) => entry.id === id);
  if (!result) throw new OperatorError(404, "unknown_provider", "Provider does not exist.");
  return result;
}
function settingsView() {
  syncThemeChoices();
  return {
    settings: getSettings(), sources: getSettingSources(), defaultWriteLayer: defaultWriteLayer(),
    definitions: SETTING_DEFS.map((def) => ({ ...def, operatorOnly: isOperatorSetting(def.key as keyof TuiSettings) })),
  };
}

export interface WebOperatorServicesOptions { isTurnActive?: () => boolean }
export class WebOperatorServices {
  readonly #codex = new CodexAuthController();
  readonly #auth = new Map<string, { status: WebAuthStatus; session: DeviceAuthSession | null; env: NodeJS.ProcessEnv }>();
  #registryItems = new Map<string, MarketItem>();
  #registryError: string | null = null;
  #feedback: { id: string; payload: FeedbackPayload; preview: SubmitPreview } | null = null;

  constructor(options: WebOperatorServicesOptions = {}) { isTurnActive = options.isTurnActive ?? (() => false); }

  #publicAuth(status: WebAuthStatus): WebAuthStatus {
    return {
      ...status, message: publicMessage(status.message),
      lines: status.lines.map((line) => publicMessage(line)),
    };
  }

  #authStatus(id: string, configured: boolean): WebAuthStatus {
    if (id === "chatgpt-codex") return this.#publicAuth(this.#codex.status());
    const flow = this.#auth.get(id);
    if (flow?.status.phase === "running") return { ...flow.status, lines: [...flow.status.lines] };
    if (configured) return webAuthStatus({ phase: "connected", message: "Credentials are configured. The first request verifies account access.", lines: [] }, Boolean(PROVIDER_DEVICE_AUTH[id]));
    if (flow && flow.status.phase !== "connected") return { ...flow.status, lines: [...flow.status.lines] };
    return webAuthStatus({ phase: "idle", message: "Not connected.", lines: [] }, Boolean(PROVIDER_DEVICE_AUTH[id]));
  }

  #providers() {
    const env = webRuntimeEnv();
    const store = loadAccountStore();
    const configs = loadConnectionConfigs();
    return PROVIDERS.map((info) => {
      let diagnostics: { valid: boolean; reason: string | null; message: string | null } = {
        valid: false, reason: "missing_key", message: "Connect this provider in the browser to configure credentials.",
      };
      const via = info.envVars.find((key) => Boolean(env[key]?.trim()));
      const environment = info.envVars.some((key) => Boolean(process.env[key]?.trim()));
      const accounts = listAccounts(store, info.id).map(({ accountId, record, active }) => ({
        accountId, kind: record.kind, active, label: record.kind === "oauth" ? record.identity?.email ?? record.identity?.label ?? accountId : accountId,
      }));
      const configured = Boolean(via);
      if (configured) {
        try {
          diagnostics = runtimeDiagnostics(connectionProbeRuntime(info.id, env));
        } catch (error) {
          diagnostics = { valid: false, reason: "invalid_config", message: publicMessage(error) };
        }
      }
      return {
        id: info.id, label: info.label, methods: info.methods, configured,
        source: configured ? environment ? "environment" : store.providers[info.id] ? "account-store" : "codex-file" : null,
        diagnostics, accounts, configuration: configs[info.id] ?? {}, auth: this.#authStatus(info.id, configured),
      };
    });
  }

  async #models(providerId?: string) {
    if (providerId !== undefined) providerId = provider(providerId).id;
    const env = webRuntimeEnv();
    const diagnostics: Array<{ providerId: string; message: string }> = [];
    const states = providerStates(env).map((state) => {
      if (!state.configured) return state;
      try {
        const runtime = connectionProbeRuntime(state.id, env);
        const configuration = runtime.getConfigurationDiagnostics();
        if (configuration.valid) return state;
        diagnostics.push({ providerId: state.id, message: publicMessage(configuration.fatalError ?? "Provider configuration is incomplete.") });
      } catch (error) {
        diagnostics.push({ providerId: state.id, message: publicMessage(error) });
      }
      return { ...state, configured: false };
    });
    const publicCatalog = syncModelCatalog();
    const codex = states.find((state) => state.id === "chatgpt-codex");
    let accountModels: Array<{ id: string; contextTokens?: number }> = [];
    if (codex?.configured && (!providerId || providerId === "chatgpt-codex")) {
      const runtime = createConsoleRuntime({ provider: "chatgpt-codex", env });
      try { accountModels = await runtime.codexModelCatalog(AbortSignal.timeout(10_000)); }
      catch (error) {
        diagnostics.push({ providerId: "chatgpt-codex", message: publicMessage(error) });
        if (error instanceof CodexCatalogRefreshError) accountModels = [...error.cachedModels];
      }
    }
    await publicCatalog;
    const catalog = reachableModelCatalog(buildFullModelCatalog(), states, { env, providerId, codexModelIds: new Set(accountModels.map((model) => model.id)) });
    const rows: Array<{ id: string; provider: string; price: string; contextWindowTokens: number | null; source: "account" | "public-catalog" }> = catalog.filter((model) => model.provider !== "chatgpt-codex").map((model) => ({
      ...model, contextWindowTokens: resolveContextLimit({ modelId: model.id, providerId: model.provider })?.tokens ?? null,
      source: "public-catalog" as const,
    }));
    for (const model of accountModels) rows.push({ id: model.id, provider: "chatgpt-codex", price: "Included in subscription", contextWindowTokens: model.contextTokens ?? null, source: "account" });
    const azureModel = env.AZURE_OPENAI_MODEL;
    if (azureModel && states.some((state) => state.id === "azure" && state.configured) && !rows.some((model) => model.provider === "azure" && model.id === azureModel)) rows.push({ id: azureModel, provider: "azure", price: "Unknown deployment rate", contextWindowTokens: null, source: "public-catalog" });
    return { models: rows.filter((model) => !providerId || model.provider === providerId), providerId: providerId ?? null, diagnostics, roles: MODEL_ROLES };
  }

  async #connections(input: unknown) {
    const body = object(input);
    const info = provider(body.providerId);
    const action = text(body.action, "connection action", 32);
    if (action === "configure") {
      const config = validateConnectionConfig(info.id, {
        ...(body.baseUrl !== undefined ? { baseUrl: text(body.baseUrl, "API endpoint") } : {}),
        ...(body.model !== undefined ? { model: text(body.model, "deployment model", 256) } : {}),
        ...(body.projectId !== undefined ? { projectId: text(body.projectId, "Google project", 256) } : {}),
      });
      if (!Object.keys(config).length) throw new OperatorError(400, "empty_configuration", "Choose a supported connection configuration field to update.");
      saveConnectionConfig(info.id, { ...loadConnectionConfigs()[info.id], ...config });
      return { providers: this.#providers() };
    }
    let store = loadAccountStore();
    if (action === "connect") {
      if (!info.methods.includes("api-key")) throw new OperatorError(400, "unsupported_auth", "Use this provider's browser sign-in flow.");
      const secret = text(body.apiKey, "API key", 16_384);
      if (/[\s\x00-\x1f\x7f]/.test(secret)) throw new OperatorError(400, "invalid_key", "API keys must not contain whitespace or control characters.");
      const config = validateConnectionConfig(info.id, {
        ...(body.baseUrl !== undefined ? { baseUrl: text(body.baseUrl, "API endpoint") } : {}),
        ...(body.model !== undefined ? { model: text(body.model, "deployment model", 256) } : {}),
      });
      if (Object.keys(config).length) saveConnectionConfig(info.id, config);
      const accountId = body.accountId === undefined ? undefined : text(body.accountId, "account ID", 128);
      if (accountId && ["__proto__", "constructor", "prototype"].includes(accountId)) throw new OperatorError(400, "invalid_account", "Invalid account ID.");
      store = addAccount(store, info.id, { kind: "api_key", secret }, { accountId, makeActive: true }).store;
    } else if (action === "disconnect") {
      if (info.envVars.some((key) => process.env[key]?.trim())) throw new OperatorError(409, "environment_owned", "This connection is supplied by the server environment and cannot be revoked by deleting a saved account.");
      if (info.id === "chatgpt-codex" && !store.providers[info.id]) throw new OperatorError(409, "official_auth_owned", "The official Codex auth file belongs to Codex. Removing another account here does not revoke that login.");
      this.#auth.get(info.id)?.session?.cancel();
      this.#auth.delete(info.id);
      store = body.accountId === undefined ? logoutProvider(store, info.id) : removeAccount(store, info.id, text(body.accountId, "account ID", 128));
    } else if (action === "activate") {
      const accountId = text(body.accountId, "account ID", 128);
      if (!store.providers[info.id]?.accounts[accountId]) throw new OperatorError(404, "unknown_account", "Saved account does not exist.");
      if (info.envVars.some((key) => process.env[key]?.trim())) throw new OperatorError(409, "environment_owned", "The explicit server credential takes precedence over saved accounts.");
      store = setActiveAccount(store, info.id, accountId);
    } else throw new OperatorError(400, "invalid_action", "Unsupported connection action.");
    if (!saveAccountStore(store)) throw new OperatorError(500, "persistence_failed", "Could not save the private credential account store.");
    return { providers: this.#providers() };
  }

  #deviceAuth(id: string, method: string) {
    const info = provider(id);
    if (info.id === "chatgpt-codex") return { status: this.#publicAuth(method === "DELETE" ? this.#codex.cancel() : this.#codex.start()) };
    const config = PROVIDER_DEVICE_AUTH[info.id];
    if (!config) throw new OperatorError(409, "auth_unavailable", "This provider does not support browser sign-in; connect its API key instead.");
    const previous = this.#auth.get(info.id);
    if (method === "DELETE") {
      previous?.session?.cancel();
      return { status: previous?.status ?? this.#authStatus(info.id, false) };
    }
    if (previous?.status.phase === "running") return { status: previous.status };
    const flow = { status: webAuthStatus({ phase: "running", message: "Starting browser sign-in.", lines: [] }), session: null as DeviceAuthSession | null, env: { ...process.env } };
    this.#auth.set(info.id, flow);
    flow.session = startDeviceAuth(config, {
      env: flow.env,
      openBrowser: (url) => {
        const safe = webAuthStatus({ phase: "running", message: "", lines: [url] });
        if (safe.verificationUrl) flow.status = { ...flow.status, verificationUrl: safe.verificationUrl };
      },
      onUpdate: (update) => {
        const status = webAuthStatus({ phase: update.phase, message: publicMessage(update.message), lines: update.lines.map((line) => publicMessage(line)) });
        flow.status = { ...status, verificationUrl: status.verificationUrl ?? flow.status.verificationUrl };
        if (update.phase !== "running") flow.session = null;
      },
      onConnected: () => undefined,
    });
    return { status: flow.status };
  }

  async #plugins() {
    const registryUrl = (process.env.ZERO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).trim();
    let publicRegistryUrl = "";
    if (registryUrl) {
      try {
        const url = new URL(registryUrl);
        url.username = ""; url.password = ""; url.search = ""; url.hash = "";
        publicRegistryUrl = url.href;
      } catch { publicRegistryUrl = "Invalid configured registry URL"; }
    }
    const fetched = await pluginService.fetchRegistry();
    this.#registryError = fetched.ok ? null : publicMessage(registryUrl ? fetched.error.split(registryUrl).join(publicRegistryUrl) : fetched.error);
    this.#registryItems = fetched.ok ? new Map(buildMarketItems(fetched.result).map((item) => [`${item.kind}:${item.id}`, item])) : new Map();
    const installed = await pluginService.list(getSettings().theme);
    const items = new Map(this.#registryItems);
    const errors = new Map<string, string>();
    for (const id of listInstalledPluginIds(pluginsRootDir())) {
      const discovered = readInstalledPlugin(pluginsRootDir(), id, { reservedToolNames });
      if (!discovered.ok) { errors.set(id, discovered.errors.join("; ")); continue; }
      const manifest = discovered.plugin.manifest;
      items.set(`plugin:${id}`, {
        id, kind: "plugin", name: manifest.name ?? id, version: manifest.version,
        description: manifest.tools.map((tool) => tool.name).join(", "),
        capabilities: aggregateCapabilities(manifest), signature: "unverified", raw: undefined,
      });
    }
    for (const theme of installedThemeEntries()) {
      if (!items.has(`theme:${theme.name}`)) items.set(`theme:${theme.name}`, {
        id: theme.name, kind: "theme", name: theme.label, version: "",
        description: theme.description, capabilities: [], signature: "unverified", raw: undefined,
      });
    }
    const host = pluginManager?.current();
    const hostStates = host?.status() ?? [];
    const loadedPluginIds = hostStates.filter((entry) => entry.state === "ready").map((entry) => entry.pluginId);
    const result = [...items.values()].map(({ raw: _raw, ...item }) => ({
      ...item, state: item.kind === "theme" ? item.id === installed.activeTheme ? "active" : installed.themes.has(item.id) ? "installed" : "available" : installed.plugins.get(item.id) ?? "available",
      loaded: loadedPluginIds.includes(item.id),
      error: errors.get(item.id) ?? (hostStates.some((state) => state.pluginId === item.id && state.state === "unavailable") ? "Plugin is unavailable in the current host." : null),
    }));
    for (const [id, error] of errors) if (!result.some((item) => item.id === id && item.kind === "plugin")) result.push({ id, kind: "plugin", name: id, version: "", description: "Installed manifest is invalid.", capabilities: [], signature: "unverified", state: "installed", loaded: false, error });
    return {
      registry: { url: publicRegistryUrl, available: fetched.ok, error: this.#registryError },
      items: result, deferred: [...deferredPlugins],
      host: { loadedPluginIds, tools: host?.toolDefinitions().map(({ name, description }) => ({ name, description })) ?? [] },
    };
  }

  async #pluginAction(action: string, input: unknown) {
    if (action === "run" && consoleExecutionProfile() === "smolvm") throw new OperatorError(409, "isolated_execution_required", "Host plugin execution is refused while SmolVM is selected. Configure and run plugins inside the approved guest image.");
    const body = object(input);
    const id = text(body.id, "plugin ID", 64);
    if (action === "install") {
      const kind = body.kind === "theme" ? "theme" : "plugin";
      // Always re-fetch validated install bytes; input never supplies executable content.
      await this.#plugins();
      if (this.#registryError) throw new OperatorError(503, "registry_unavailable", this.#registryError);
      const item = this.#registryItems.get(`${kind}:${id}`);
      if (!item) throw new OperatorError(404, "unknown_artifact", "The configured registry has no installable artifact with that ID.");
      const result = await pluginService.install(item);
      if (!result.ok) throw new OperatorError(409, "install_failed", result.message);
      reloadInstalledThemes();
      return result;
    }
    if (!isSafePluginId(id)) throw new OperatorError(400, "invalid_plugin", "Invalid plugin ID.");
    if (action === "disable") {
      if (!writeEnablement(process.cwd(), disable(readEnablement(process.cwd()), id))) throw new OperatorError(500, "persistence_failed", "Could not save plugin approval removal.");
      deferredPlugins.delete(id);
      // Approval removal is durable now; host reconciliation happens at the
      // next explicit session/run boundary, never by interrupting a leased host.
      return { ok: true, message: "Disabled for future sessions. Already leased sessions keep their approved host until cleanup.", state: "installed" };
    }
    const discovered = readInstalledPlugin(pluginsRootDir(), id, { reservedToolNames });
    if (!discovered.ok) throw new OperatorError(409, "invalid_plugin", discovered.errors.join("; "));
    const manifest = discovered.plugin.manifest;
    const capabilities = aggregateCapabilities(manifest);
    const item: MarketItem = { id, kind: "plugin", name: manifest.name ?? id, version: manifest.version, description: "", capabilities, signature: "unverified", raw: undefined };
    if (action === "enable") {
      if (body.approved !== true || body.version !== manifest.version || !Array.isArray(body.capabilities) || body.capabilities.some((entry) => typeof entry !== "string") ||
        JSON.stringify([...new Set(body.capabilities)].sort()) !== JSON.stringify([...capabilities].sort())) throw new OperatorError(409, "approval_required", "Inspect and explicitly approve this installed version and its exact capabilities before enabling.");
      const result = await pluginService.enable(item);
      if (!result.ok) throw new OperatorError(409, "enable_failed", result.message);
      return result;
    }
    if (action !== "run") throw new OperatorError(404, "unknown_action", "Unsupported plugin action.");
    const result = await pluginService.run(item);
    if (result.deferred) deferredPlugins.add(id);
    else if (!result.ok) throw new OperatorError(409, "run_failed", result.message);
    return result;
  }

  async handle(pathname: string, method: string, input: unknown, query: URLSearchParams): Promise<{ status: number; data: unknown } | null> {
    if (!pathname.startsWith("/api/console/")) return null;
    const path = pathname.slice("/api/console/".length);
    if (!/^(providers(?:\/[^/]+(?:\/device-auth)?)?|models|connections|settings(?:\/reset)?|themes|plugins(?:\/(?:install|enable|disable|run))?|doctor|tools|project|checks|feedback)$/.test(path)) return null;
    try {
      let data: unknown;
      let status = 200;
      if (path === "providers" && method === "GET") data = { providers: this.#providers(), preference: getSettings().modelPreference };
      else if (path === "models" && method === "GET") data = await this.#models(query.get("providerId") ?? undefined);
      else if (path === "connections" && method === "POST") data = await this.#connections(input);
      else if (/^providers\/[^/]+\/device-auth$/.test(path) && ["POST", "DELETE"].includes(method)) {
        data = this.#deviceAuth(decodeURIComponent(path.split("/")[1]!), method); status = method === "POST" ? 202 : 200;
      } else if (/^providers\/[^/]+$/.test(path) && method === "GET") {
        const info = provider(decodeURIComponent(path.split("/")[1]!));
        const state = this.#providers().find((entry) => entry.id === info.id)!;
        data = { provider: state, status: state.auth };
      } else if (path === "settings" && method === "GET") data = settingsView();
      else if (path === "settings" && method === "PATCH") {
        const body = object(input);
        const key = text(body.key, "setting", 128);
        const def = SETTING_DEFS.find((entry) => entry.key === key);
        const internalBoolean = key === "onboardingCompleted" || key === "diagnosticReportingPrompted";
        if (!def && !internalBoolean) throw new OperatorError(400, "unknown_setting", "Only declared settings can be changed here. Model preferences are saved by successful runtime selection.");
        if (body.scope !== undefined && body.scope !== "global" && body.scope !== "project") throw new OperatorError(400, "invalid_scope", "Settings scope must be global or project.");
        if (isOperatorSetting(key as keyof TuiSettings) && body.scope === "project") throw new OperatorError(400, "operator_global", "Operator consent and execution preferences can only be changed globally.");
        if (internalBoolean ? typeof body.value !== "boolean" : def!.kind === "boolean" ? typeof body.value !== "boolean" : key === "theme" ? !isKnownTheme(body.value) : typeof body.value !== "string" || !def!.choices?.includes(body.value)) throw new OperatorError(400, "invalid_value", "The value is not supported by this setting.");
        const persisted = updateSetting(key as keyof TuiSettings, body.value as TuiSettings[keyof TuiSettings], { scope: body.scope as "global" | "project" | undefined });
        data = { ...settingsView(), persisted, ...(!persisted ? { error: "Settings changed in this process but could not be saved to disk.", code: "persistence_failed" } : {}) };
        if (!persisted) status = 507;
      } else if (path === "settings/reset" && method === "POST") {
        const body = object(input);
        const keys = body.keys ?? SETTING_DEFS.map((def) => def.key);
        if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !SETTING_DEFS.some((def) => def.key === key))) throw new OperatorError(400, "invalid_setting", "Reset keys must name declared settings.");
        const persisted = resetSettings(DEFAULT_SETTINGS, keys as Array<keyof TuiSettings>);
        data = { ...settingsView(), persisted, ...(!persisted ? { error: "Settings reset in this process but could not be saved to disk.", code: "persistence_failed" } : {}) };
        if (!persisted) status = 507;
      } else if (path === "themes" && method === "GET") data = { active: getSettings().theme, themes: allThemeNames().map((name) => ({ ...getThemeEntry(name) })) };
      else if (path === "plugins" && method === "GET") data = await this.#plugins();
      else if (path.startsWith("plugins/") && method === "POST") data = await this.#pluginAction(path.split("/")[1]!, input);
      else if (path === "doctor" && method === "GET") {
        const providers = this.#providers();
        const availability = await getRuntimeAvailability();
        const ready = providers.find((entry) => entry.diagnostics.valid);
        const settings = getSettings();
        data = {
          version: VERSION, runtime: { ...getRuntimeMetadata(), node: process.version, nodeSupported: Number(process.versions.node.split(".")[0]) >= 24 },
          availability: { ...availability, hasApiKey: Boolean(ready), apiRuntime: ready ? { configured: true, valid: true, providerLabel: ready.label } : { ...availability.apiRuntime, error: availability.apiRuntime.error ? publicMessage(availability.apiRuntime.error) : undefined } },
          providers, prerequisites: [{ id: "node", available: Number(process.versions.node.split(".")[0]) >= 24, required: true }, { id: "codex", available: providers.find((entry) => entry.id === "chatgpt-codex")!.auth.available, required: false }],
          settings: { onboardingCompleted: settings.onboardingCompleted, analyticsLevel: settings.analyticsLevel, diagnosticReporting: settings.diagnosticReporting, executionProfile: settings.executionProfile },
        };
      } else if (path === "tools" && method === "GET") {
        const roleTools: Record<string, Set<string>> = Object.fromEntries(MODEL_ROLES.map((role) => [role, new Set(getToolsForRole(role, { hasScope: true, webMode: true, hasBrowser: true, allowScanners: true }).map((tool) => tool.name))]));
        data = { roles: MODEL_ROLES, tools: Object.values(TOOL_DEFINITIONS).map(({ name, description }) => ({ name, description, roles: MODEL_ROLES.filter((role) => roleTools[role]!.has(name)) })), plugins: pluginManager?.current().toolDefinitions().map(({ name, description }) => ({ name, description })) ?? [] };
      } else if (path === "project" && method === "GET") {
        const projectPath = realpathSync(resolve(query.get("path") ?? process.cwd()));
        if (!statSync(projectPath).isDirectory()) throw new OperatorError(400, "invalid_project", "Project path must name a local directory.");
        const git: { root: string | null; branch: string | null; dirty: boolean; error: string | null } = { root: null, branch: null, dirty: false, error: null };
        try {
          git.root = execFileSync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
          git.branch = execFileSync("git", ["-C", projectPath, "branch", "--show-current"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
          git.dirty = Boolean(execFileSync("git", ["-C", projectPath, "status", "--porcelain"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1_048_576 }).trim());
        } catch { git.error = "Git metadata is unavailable for this directory."; }
        data = { path: projectPath, name: basename(projectPath), git };
      } else if (path === "checks" && method === "GET") data = listProjectReviewChecks(query.get("path") ?? process.cwd());
      else if (path === "checks" && method === "POST") {
        const body = object(input);
        const mutation = object(body.mutation);
        const action = text(mutation.action, "review check action", 32);
        if (!["propose", "add", "enable", "disable", "set", "remove"].includes(action)) throw new OperatorError(400, "invalid_action", "Unsupported review check action.");
        if (mutation.approved !== undefined && typeof mutation.approved !== "boolean") throw new OperatorError(400, "invalid_approval", "Approval must be an explicit boolean.");
        if (mutation.expectedRevision !== undefined && (!Number.isSafeInteger(mutation.expectedRevision) || Number(mutation.expectedRevision) < 1)) throw new OperatorError(400, "invalid_revision", "Expected revision must be a positive integer.");
        data = updateProjectReviewChecks(body.path === undefined ? process.cwd() : text(body.path, "project path"), mutation as unknown as ReviewCheckMutation);
      } else if (path === "feedback" && method === "POST") {
        const body = object(input);
        if (body.action === "cancel") {
          this.#feedback = null;
          data = { cancelled: true, submitted: false };
        } else if (body.action === "send") {
          const staged = this.#feedback;
          if (!staged || body.previewId !== staged.id) throw new OperatorError(409, "review_required", "Review and confirm the staged feedback before sending.");
          const result = await submitFeedback(staged.payload, process.env, { expectedPreview: staged.preview });
          if (!result.ok) throw new OperatorError(409, "submission_failed", result.error ?? "Feedback could not be submitted.");
          this.#feedback = null;
          data = { saved: true, submitted: true };
        } else {
          if (body.submit !== undefined && typeof body.submit !== "boolean") throw new OperatorError(400, "invalid_submission", "Submission must be explicitly selected.");
          const payload: FeedbackPayload = { message: text(body.message, "feedback", 16_000), timestamp: new Date().toISOString(), version: VERSION };
          const saved = appendFeedback(payload);
          if (!saved.ok) throw new OperatorError(500, "persistence_failed", saved.error ?? "Could not save local feedback.");
          if (body.submit === true) {
            const preview = buildSubmitPreview(payload);
            if (!preview) throw new OperatorError(409, "submission_unavailable", "Local feedback was saved, but reporting is opted out or no supported HTTPS destination is available.");
            const id = randomUUID();
            this.#feedback = { id, payload, preview };
            data = { saved: true, path: saved.path, submitted: false, previewId: id, preview: { ...preview, url: publicMessage(preview.url) } };
          } else data = { saved: true, path: saved.path, submitted: false };
        }
      } else throw new OperatorError(405, "method_not_allowed", "This operation does not support that HTTP method.");
      return { status, data };
    } catch (error) {
      return { status: error instanceof OperatorError ? error.status : 400, data: { error: publicMessage(error), code: error instanceof OperatorError ? error.code : "operation_failed" } };
    }
  }

  dispose(): void {
    this.#codex.cancel();
    for (const flow of this.#auth.values()) flow.session?.cancel();
    pluginManager?.dispose();
  }
}
