import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createNativeApiRuntime, isApiRuntime, runtimeFromPrivateWorkerBinding, type ConsoleRuntime, 
  createConsoleRuntime, CodexCatalogRefreshError, DEFAULT_REGISTRY_URL,
  TOOL_DEFINITIONS, getToolsForRole, aggregateCapabilities, disable, readEnablement, writeEnablement,
  listInstalledPluginIds, pluginsRootDir, readInstalledPlugin, isSafePluginId,
  listProjectReviewChecks, updateProjectReviewChecks,
  type NativeRuntime, type RuntimeConfig, type ReviewCheckMutation } from "@0/engine";
import { VERSION, modelProvider, type ConsoleRuntimeSelection, type ConsoleRuntimeSnapshot } from "@0/engine/shared";
import {
  credentialEnvPatch, loadCredentials, accountEnvPatch, loadAccountStore, saveAccountStore,
  addAccount, removeAccount, logoutProvider, setActiveAccount, listAccounts,
} from "../state/credential-store.js";
import { maybeLoadCodexAuth } from "../codex-auth.js";
import { PROVIDERS, isRemovedProviderId, providerStates } from "../state/provider-status.js";
import { createPreferredConsoleRuntime, saveAppliedModelPreference } from "../state/model-preference.js";
import { buildFullModelCatalog } from "../state/model-catalog.js";
import { discoverConnectionModels } from "../state/available-models.js";

type ModelDiscoveryResult = Awaited<ReturnType<typeof discoverConnectionModels>>;
/** Discovery results are served from memory this long before a background refresh. */
const MODEL_CACHE_TTL_MS = 60_000;
/** Failed discovery is retried sooner so a transient outage heals quickly. */
const MODEL_FAILURE_TTL_MS = 5_000;
/** Longest a cold (never cached) provider may delay the response. */
const MODEL_COLD_WAIT_MS = 2_500;
import { syncModelCatalog } from "../state/model-catalog-sync.js";
import { resolveContextLimit } from "../state/context-window.js";
import { startDeviceAuth, PROVIDER_DEVICE_AUTH, type DeviceAuthSession } from "../state/device-auth.js";
import { getSettings, getSettingSources, updateSetting, resetSettings, defaultWriteLayer } from "../state/settings-store.js";
import { DEFAULT_SETTINGS, SETTING_DEFS, isOperatorSetting, type TuiSettings } from "../state/settings.js";
import { createPluginService, type PluginRunResult } from "../state/plugin-service.js";
import { buildMarketItems, type MarketItem } from "../state/market-layout.js";
import { createSessionPluginHostManager, type SessionPluginHostManager } from "../state/session-plugin-host.js";
import { getRuntimeAvailability } from "../utils.js";
import { getRuntimeMetadata } from "../state/runtime.js";
import { ChatGptPlanAuthController } from "./chatgpt-plan-controller.js";
import { getSiwcConnection, listChatGptPlanProfiles, selectChatGptPlanProfile, signOutChatGptPlan } from "../state/chatgpt-plan-store.js";
import { CodexAuthController, webAuthStatus, type WebAuthStatus } from "./codex-auth-controller.js";
import { connectionConfigEnvPatch, loadConnectionConfigs, saveConnectionConfig, validateConnectionConfig } from "./connection-config.js";
import { ServicePluginServices } from "./service-plugins.js";
import { CustomMcpServices } from "./custom-mcp.js";
import { GithubPluginInstaller, readPluginSource } from "./github-plugin-install.js";
import { ConnectionExtras, applySpread, connectionLabel, pruneConnectionMeta, disabledModelsFor, isModelDisabled, loadConnectionMeta, orderedAccountIds } from "./connection-meta.js";
import { IconCache, connectorLogo } from "./connector-logos.js";
import { appendFeedback, buildSubmitPreview, submitFeedback, type FeedbackPayload, type SubmitPreview } from "../state/feedback.js";

import { consoleExecutionProfile } from "../console-execution.js";
import { readUpdateStatus } from "./update-status.js";
import { listWorkspaceDirectories } from "./workspace-directories.js";
import { chooseWorkspaceFolder } from "./workspace-folder-picker.js";

const MODEL_ROLES = ["discovery", "attack", "verify", "report", "audit", "review"];
const reservedToolNames = Object.values(TOOL_DEFINITIONS).map((tool) => tool.name);
const runtimeEnvironments = new WeakMap<ConsoleRuntime, Record<string, string>>();
interface WebRuntimePolicy { allowChatGptPlan?: boolean; requiredProgramConnectionIdentity?: string | null }
function assertPlanAllowed(providerId: string | undefined, policy: WebRuntimePolicy): void {
  if (providerId === "chatgpt-plan" && policy.allowChatGptPlan === false) throw new OperatorError(403, "local_only", "Native ChatGPT plan connections are available only in the local open-source application.");
}
const runtimeContextLimits = new WeakMap<ConsoleRuntime, number>();
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

/** `rotate` is true only for NEW runtime creation so read-only views never advance spread rotation. */
function webRuntimeEnv(rotate = false): Record<string, string> {
  // Re-read only file-derived bootstrap credentials before copying the env.
  // Explicit exports still win; existing chat runtimes retain their snapshots.
  maybeLoadCodexAuth();
  const env = { ...process.env };
  Object.assign(env, connectionConfigEnvPatch(env), credentialEnvPatch(loadCredentials(), env), accountEnvPatch(rotate ? applySpread(loadAccountStore()) : loadAccountStore(), env));
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

function runtimeDiagnostics(runtime: ConsoleRuntime) {
  const diagnostics = runtime.getConfigurationDiagnostics();
  return {
    valid: diagnostics.valid,
    reason: diagnostics.reason ?? null,
    message: diagnostics.fatalError ? publicMessage(diagnostics.fatalError) : null,
  };
}

/** Inspect connection configuration without choosing or requesting an inference model. */
function connectionProbeRuntime(providerId: string, env: Record<string, string>): ConsoleRuntime {
  return createNativeApiRuntime({
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
  const api = isApiRuntime(runtime) ? runtime : undefined;
  const diagnostics = api ? runtimeDiagnostics(api) : { valid: true, reason: null, message: null };
  const accessProgram = api?.cyberAccessProgramConfiguration();
  return {
    providerId, providerLabel: PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId,
    model, configured: diagnostics.valid, reasoning: api?.reasoningConfiguration() ?? null,
    connectionIdentity: api?.connectionIdentity() ?? null,
    accessProgram: accessProgram ? { ...accessProgram, requested: accessProgram.requested ?? null } : { requested: null, options: [], unavailableReason: "This runtime does not support explicit cyber access programs." },
    diagnostics, ...(runtime.modelSelection?.() ?? { agentModels: {}, singleModel: false, autoRoute: false }),
    contextWindowTokens: (api ? runtimeContextLimits.get(api) : undefined) ?? api?.publishedContextWindowTokens() ?? resolveContextLimit({ modelId: model, providerId })?.tokens ?? null,
  };
}

/** Secret-bearing IPC bootstrap. Send only on the private host-worker pipe. */
export interface WebConsoleRuntimeBootstrap {
  version: 1;
  binding: ReturnType<ConsoleRuntime["exportPrivateWorkerBinding"]>;
  contextWindowTokens?: number;
}

export function captureWebConsoleRuntimeBootstrap(runtime: NativeRuntime): WebConsoleRuntimeBootstrap {
  if (!(isApiRuntime(runtime))) throw new Error("This runtime cannot be moved to a host session worker.");
  return { version: 1, binding: runtime.exportPrivateWorkerBinding(),
    ...(runtimeContextLimits.has(runtime) ? { contextWindowTokens: runtimeContextLimits.get(runtime)! } : {}) };
}

export function createWebConsoleRuntimeFromBootstrap(bootstrap: WebConsoleRuntimeBootstrap): { runtime: ConsoleRuntime; info: ConsoleRuntimeSnapshot } {
  if (bootstrap.version !== 1) throw new Error("Unsupported host worker runtime bootstrap.");
  const runtime = runtimeFromPrivateWorkerBinding(bootstrap.binding);
  if (bootstrap.contextWindowTokens !== undefined) {
    if (!Number.isFinite(bootstrap.contextWindowTokens) || bootstrap.contextWindowTokens <= 0) throw new Error("Invalid host worker context window.");
    runtimeContextLimits.set(runtime, bootstrap.contextWindowTokens);
  }
  return { runtime, info: describeWebConsoleRuntime(runtime) };
}

/** Host verifies the active worker epoch first; account/selection cannot change here. */
export function applyWebConsoleRuntimeBootstrap(runtime: NativeRuntime, bootstrap: WebConsoleRuntimeBootstrap): void {
  if (!(isApiRuntime(runtime)) || bootstrap.version !== 1) throw new Error("Unsupported host worker runtime checkpoint.");
  runtime.applyPrivateWorkerBinding(bootstrap.binding);
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
    singleModel: info.singleModel, autoRoute: info.autoRoute, ...(info.accessProgram ? { cyberAccessProgram: info.accessProgram.requested } : {}), ...reasoning,
  };
}

function validateSelection(selection: ConsoleRuntimeSelection): void {
  if (isRemovedProviderId(selection.providerId)) throw new OperatorError(400, "provider_removed", "That provider is no longer supported. Choose another connection; your saved credentials were not deleted.");
  if (selection.providerId !== undefined && !PROVIDERS.some((provider) => provider.id === selection.providerId)) throw new OperatorError(400, "invalid_provider", "Unsupported provider.");
  for (const value of [selection.model, ...Object.values(selection.agentModels ?? {})]) {
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value))) throw new OperatorError(400, "invalid_model", "Model identifiers must be non-empty and contain no whitespace.");
  }
  if (selection.reasoningEffort !== undefined && !["none", "low", "medium", "high", "xhigh", "max"].includes(selection.reasoningEffort)) throw new OperatorError(400, "invalid_reasoning_effort", "Choose an available thinking effort.");
  if (selection.cyberAccessProgram !== undefined && selection.cyberAccessProgram !== null && !["standard", "daybreak_blue", "daybreak_red"].includes(selection.cyberAccessProgram)) throw new OperatorError(400, "invalid_access_program", "Choose an available cyber access program.");
  for (const key of Object.keys(selection.agentModels ?? {})) if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) throw new OperatorError(400, "invalid_role", "Invalid model role.");
}

/** Per-connection model switch: an explicitly selected model the operator disabled for the active account is refused. */
function assertSelectionModelsEnabled(selection: ConsoleRuntimeSelection, currentProvider?: string): void {
  const models = [selection.model, ...Object.values(selection.agentModels ?? {})].filter((model): model is string => typeof model === "string" && model !== "auto");
  if (!models.length) return;
  const providerId = selection.providerId ?? (selection.model ? modelProvider(selection.model) : undefined) ?? currentProvider;
  const store = loadAccountStore();
  for (const id of new Set([providerId, currentProvider].filter((value): value is string => !!value && value !== "unknown"))) {
    const disabled = disabledModelsFor(id, store);
    if (disabled.size && models.some(model => isModelDisabled(disabled, model))) throw new OperatorError(409, "model_disabled", "That model is turned off for this connection. Enable it in Connections first.");
  }
}

function accessProgramSelectionError(error: unknown): never {
  if (/Cyber access program/i.test(error instanceof Error ? error.message : String(error))) throw new OperatorError(400, "unsupported_access_program", publicMessage(error));
  throw error;
}

async function validateRuntimeModels(runtime: ConsoleRuntime): Promise<void> {
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
  if (diagnostics.provider === "chatgpt-plan") {
    const models = await runtime.availableModelCatalog(AbortSignal.timeout(10_000));
    if (!models.some(model => model.id === runtime.resolvedModel())) throw new OperatorError(409, "model_not_available", "This model is not available to the connected ChatGPT plan.");
    for (const model of Object.values(runtime.modelSelection().agentModels)) {
      if (model !== "auto" && !models.some(entry => entry.id === model)) throw new OperatorError(409, "model_not_available", "A role model is not available to the connected ChatGPT plan.");
    }
  }
  for (const role of Object.keys(runtime.modelSelection().agentModels)) {
    if (runtime.modelSelection().agentModels[role] !== "auto") await runtime.forkForSubagent(120_000, { role });
  }
}

export async function createWebConsoleRuntime(selection: ConsoleRuntimeSelection = {}, policy: WebRuntimePolicy = {}): Promise<{ runtime: ConsoleRuntime; info: ConsoleRuntimeSnapshot }> {
  validateSelection(selection);
  assertPlanAllowed(selection.providerId, policy);
  assertSelectionModelsEnabled(selection);
  const env = webRuntimeEnv(true);
  if (!selection.providerId) assertPlanAllowed(env.ZERO_SELECTED_PROVIDER || env.ZERO_PROVIDER || env.ZERO_FORCE_PROVIDER, policy);
  const { runtime } = await createPreferredConsoleRuntime({
    provider: selection.providerId as RuntimeConfig["provider"], model: selection.model,
    agentModels: selection.agentModels, singleModel: selection.singleModel, autoRoute: selection.autoRoute, env,
    ...(selection.providerId === "chatgpt-plan" ? { siwcConnection: getSiwcConnection(env.HOME) } : {}),
  }, { ...policy, cyberAccessProgram: policy.requiredProgramConnectionIdentity !== undefined ? null : selection.cyberAccessProgram }).catch(accessProgramSelectionError);
  if (policy.requiredProgramConnectionIdentity !== undefined && selection.cyberAccessProgram != null) {
    if (!policy.requiredProgramConnectionIdentity || runtime.connectionIdentity() !== policy.requiredProgramConnectionIdentity) throw new OperatorError(409, "access_program_connection_changed", "This saved cyber access program belongs to a different or unverified connection. Explicitly choose the program again for this account, or clear it.");
    try { runtime.setCyberAccessProgram(selection.cyberAccessProgram); } catch (error) { accessProgramSelectionError(error); }
  }
  await validateRuntimeModels(runtime);
  if (selection.reasoningEffort !== undefined) {
    try { runtime.setReasoningEffort(selection.reasoningEffort); }
    catch { throw new OperatorError(400, "unsupported_reasoning_effort", "Choose an available thinking effort for this model."); }
  }
  runtimeEnvironments.set(runtime, env);
  if (selection.model !== undefined || selection.cyberAccessProgram !== undefined) saveAppliedModelPreference(runtime);
  return { runtime, info: describeWebConsoleRuntime(runtime) };
}

/** Explicit reconnect validates current stored credentials before replacing a session's captured connection. */
export async function reloadWebConsoleRuntimeConnection(runtime: ConsoleRuntime, policy: WebRuntimePolicy = {}): Promise<ConsoleRuntimeSnapshot> {
  const providerId = runtime.resolvedProvider(); const model = runtime.resolvedModel();
  assertPlanAllowed(providerId, policy);
  if (providerId === "chatgpt-plan") {
    // A live chat keeps its captured registration even if another profile becomes active.
    await validateRuntimeModels(runtime);
    return describeWebConsoleRuntime(runtime);
  }
  const effort = runtime.reasoningConfiguration()?.effort;
  const env = webRuntimeEnv();
  const { runtime: candidate } = await createPreferredConsoleRuntime({
    provider: providerId as RuntimeConfig["provider"], model, ...runtime.modelSelection(), env,
  }, policy);
  if (candidate.resolvedProvider() !== providerId || candidate.resolvedModel() !== model) throw new OperatorError(409, "connection_changed", "Reconnect the conversation's selected provider and model first.");
  await validateRuntimeModels(candidate);
  candidate.setCyberAccessProgram(runtime.getCyberAccessProgram() ?? null);
  if (effort !== undefined) candidate.setReasoningEffort(effort);
  runtime.refreshConnection(env);
  runtimeEnvironments.set(runtime, env);
  const contextTokens = runtimeContextLimits.get(candidate);
  if (contextTokens) runtimeContextLimits.set(runtime, contextTokens); else runtimeContextLimits.delete(runtime);
  return describeWebConsoleRuntime(runtime);
}

export async function applyWebConsoleRuntimeSelection(runtime: ConsoleRuntime, selection: ConsoleRuntimeSelection, policy: WebRuntimePolicy = {}): Promise<ConsoleRuntimeSnapshot> {
  validateSelection(selection);
  assertSelectionModelsEnabled(selection, runtime.resolvedProvider());
  const { cyberAccessProgram: _requestedProgram, ...runtimeSelection } = selection;
  const currentProvider = runtime.resolvedProvider();
  let providerId = selection.providerId;
  if (providerId === undefined && selection.model !== undefined) {
    const inferred = modelProvider(selection.model);
    if (inferred !== "unknown" && inferred !== currentProvider && !(["chatgpt-codex", "chatgpt-plan"].includes(currentProvider) && inferred === "openai")) providerId = inferred;
  }
  const targetProvider = providerId ?? currentProvider;
  const cyberAccessProgram = selection.cyberAccessProgram !== undefined ? selection.cyberAccessProgram : runtime.getCyberAccessProgram() ?? null;
  assertPlanAllowed(targetProvider, policy);
  let candidate: ConsoleRuntime;
  let planConnection: ReturnType<typeof getSiwcConnection> | undefined;
  if (targetProvider !== currentProvider) {
    const env = webRuntimeEnv(true);
    if (targetProvider === "chatgpt-plan") planConnection = getSiwcConnection(env.HOME);
    const created = await createPreferredConsoleRuntime({
      provider: targetProvider as RuntimeConfig["provider"], model: selection.model, env,
      ...runtime.modelSelection(), ...runtimeSelection,
      ...(planConnection ? { siwcConnection: planConnection } : {}),
    }, policy);
    candidate = created.runtime;
    try { candidate.setCyberAccessProgram(cyberAccessProgram); } catch (error) { accessProgramSelectionError(error); }
    await validateRuntimeModels(candidate);
    runtimeEnvironments.set(candidate, env);
  } else {
    // Fork captures this live connection, not freshly replaced account credentials.
    candidate = await runtime.forkForSubagent(120_000);
    try { candidate.reconfigure({ ...runtime.modelSelection(), ...selection, cyberAccessProgram }); } catch (error) { accessProgramSelectionError(error); }
    await validateRuntimeModels(candidate);
  }
  if (selection.reasoningEffort !== undefined) {
    try { candidate.setReasoningEffort(selection.reasoningEffort); }
    catch { throw new OperatorError(400, "unsupported_reasoning_effort", "Choose an available thinking effort for this model."); }
  }
  runtime.reconfigure({
    model: candidate.resolvedModel(), provider: targetProvider, cyberAccessProgram,
    ...(planConnection ? { siwcConnection: planConnection } : {}),
    ...candidate.modelSelection(),
    ...(targetProvider !== currentProvider ? { env: runtimeEnvironments.get(candidate) } : {}),
  });
  if (targetProvider !== currentProvider) runtimeEnvironments.set(runtime, runtimeEnvironments.get(candidate)!);
  const reasoning = candidate.reasoningConfiguration();
  if (reasoning) runtime.setReasoningEffort(reasoning.effort);
  const contextTokens = runtimeContextLimits.get(candidate);
  if (contextTokens) runtimeContextLimits.set(runtime, contextTokens);
  else runtimeContextLimits.delete(runtime);
  if (selection.model !== undefined || selection.cyberAccessProgram !== undefined) saveAppliedModelPreference(runtime);
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
  return {
    settings: getSettings(), sources: getSettingSources(), defaultWriteLayer: defaultWriteLayer(),
    definitions: SETTING_DEFS.map((def) => ({ ...def, operatorOnly: isOperatorSetting(def.key as keyof TuiSettings) })),
  };
}

interface WebOperatorServicesOptions { isTurnActive?: () => boolean; allowChatGptPlan?: boolean }
/**
 * Safety and privacy settings never loosen through Reset. Ordered strictest first; the default is only
 * applied when it is at least as strict as the current value. "Reset all" (no explicit keys) leaves them
 * untouched and reports them in `preserved`; naming them explicitly resets them only toward the strict side.
 */
const GUARDED_SETTING_ORDER: Partial<Record<keyof TuiSettings, readonly unknown[]>> = {
  analyticsLevel: ["off", "usage"],
  diagnosticReporting: ["off", "ask", "automatic"],
  updatePolicy: ["off", "notify", "automatic"],
  executionProfile: ["smolvm", "local"],
  allowModelSelfExtension: [false, true],
  allowDevSourceUpdates: [false, true],
};
export function planSettingsReset(requested: readonly (keyof TuiSettings)[], explicit: boolean, current: TuiSettings): { keys: Array<keyof TuiSettings>; preserved: Array<{ key: string; reason: string }> } {
  const keys: Array<keyof TuiSettings> = []; const preserved: Array<{ key: string; reason: string }> = [];
  for (const key of requested) {
    const order = GUARDED_SETTING_ORDER[key];
    if (!order) { keys.push(key); continue; }
    if (!explicit) { preserved.push({ key, reason: "Safety and privacy settings are not changed by Reset all. Reset them individually." }); continue; }
    const now = order.indexOf(current[key]); const fallback = order.indexOf(DEFAULT_SETTINGS[key]);
    if (now === -1 || fallback <= now) keys.push(key);
    else { preserved.push({ key, reason: "The default is less strict than your current choice, so it was kept." }); }
  }
  return { keys, preserved };
}

export class WebOperatorServices {
  readonly #servicePlugins = new ServicePluginServices();
  readonly #customMcp = new CustomMcpServices();
  readonly #githubPlugins = new GithubPluginInstaller();
  readonly #connectionExtras = new ConnectionExtras({ knownProvider: id => PROVIDERS.some(info => info.id === id) });
  readonly #icons = new IconCache();
  readonly #codex = new CodexAuthController();
  readonly #plan = new ChatGptPlanAuthController();
  readonly #allowChatGptPlan: boolean;
  readonly #auth = new Map<string, { status: WebAuthStatus; session: DeviceAuthSession | null; env: NodeJS.ProcessEnv }>();
  #catalogRefresh: Promise<unknown> | undefined;
  #registryItems = new Map<string, MarketItem>();
  #registryError: string | null = null;
  #feedback: { id: string; payload: FeedbackPayload; preview: SubmitPreview } | null = null;

  constructor(options: WebOperatorServicesOptions = {}) { isTurnActive = options.isTurnActive ?? (() => false); this.#allowChatGptPlan = options.allowChatGptPlan !== false; }

  #publicAuth(status: WebAuthStatus): WebAuthStatus {
    return {
      ...status, message: publicMessage(status.message),
      lines: status.lines.map((line) => publicMessage(line)),
    };
  }

  #authStatus(id: string, configured: boolean): WebAuthStatus {
    if (id === "chatgpt-plan") return this.#plan.status();
    if (id === "chatgpt-codex") return this.#publicAuth(this.#codex.status());
    const flow = this.#auth.get(id);
    if (flow?.status.phase === "running") return { ...flow.status, lines: [...flow.status.lines] };
    if (configured) return webAuthStatus({ phase: "connected", message: "Credentials are configured. The first request verifies account access.", lines: [] }, Boolean(PROVIDER_DEVICE_AUTH[id]));
    if (flow && flow.status.phase !== "connected") return { ...flow.status, lines: [...flow.status.lines] };
    return webAuthStatus({ phase: "idle", message: PROVIDERS.find(p => p.id === id)?.hint ?? "Not connected.", lines: [] }, Boolean(PROVIDER_DEVICE_AUTH[id]));
  }

  #providers() {
    const env = webRuntimeEnv();
    const store = loadAccountStore();
    const configs = loadConnectionConfigs();
    return PROVIDERS.filter(info => this.#allowChatGptPlan || info.id !== "chatgpt-plan").map((info) => {
      if (info.id === "chatgpt-plan") {
        const profiles = listChatGptPlanProfiles();
        const active = profiles.find(p => p.active && p.status === "connected");
        return { id: info.id, label: info.label, methods: info.methods, configured: Boolean(active), source: active ? "account-store" : null,
          diagnostics: { valid: Boolean(active?.sharing), reason: active?.sharing ? null : active ? "plan_sharing_required" : "missing_connection", message: active?.sharing ? null : active ? "ChatGPT identity is connected. Grant plan usage to use models." : "Connect your ChatGPT account." },
          accounts: profiles.map(p => ({ accountId: p.id, kind: "oauth", active: p.active, label: p.label, status: p.status, sharing: p.sharing })), configuration: {}, auth: this.#plan.status() };
      }
      let diagnostics: { valid: boolean; reason: string | null; message: string | null } = {
        valid: false, reason: "missing_key", message: "Connect this provider in the browser to configure credentials.",
      };
      const via = info.envVars.find((key) => Boolean(env[key]?.trim()));
      const environment = info.envVars.some((key) => Boolean(process.env[key]?.trim()));
      const meta = loadConnectionMeta();
      const order = orderedAccountIds(store, meta, info.id);
      const accounts = listAccounts(store, info.id).map(({ accountId, record, active }) => ({
        accountId, kind: record.kind, active, label: connectionLabel(meta, info.id, accountId) ?? (record.kind === "oauth" ? record.identity?.email ?? record.identity?.label ?? accountId : accountId),
        order: order.indexOf(accountId),
      })).sort((a, b) => a.order - b.order);
      const configured = Boolean(via);
      let connectionIdentity: string | null = null;
      if (configured) {
        try {
          const runtime = connectionProbeRuntime(info.id, env);
          diagnostics = runtimeDiagnostics(runtime);
          connectionIdentity = runtime.connectionIdentity() ?? null;
        } catch (error) {
          diagnostics = { valid: false, reason: "invalid_config", message: publicMessage(error) };
        }
      }
      return {
        id: info.id, label: info.id === "openai" ? "OpenAI / Custom AI Provider" : info.label, methods: info.methods.includes("api-key") && !PROVIDER_DEVICE_AUTH[info.id] ? info.methods.filter(method => method !== "oauth") : info.methods, configured,
        connectionIdentity,
        source: configured ? environment ? "environment" : store.providers[info.id] ? "account-store" : "codex-file" : null,
        diagnostics, accounts, configuration: configs[info.id] ?? {}, auth: this.#authStatus(info.id, configured),
      };
    });
  }

  /** Per-provider discovery cache: stale-while-revalidate with in-flight coalescing. */
  readonly #modelCache = new Map<string, { at: number; ok: boolean; result: ModelDiscoveryResult }>();
  readonly #modelRefresh = new Map<string, Promise<ModelDiscoveryResult>>();
  #modelGeneration = 0;

  #refreshModels(env: ReturnType<typeof webRuntimeEnv>, providerId: string): Promise<ModelDiscoveryResult> {
    const running = this.#modelRefresh.get(providerId);
    if (running) return running;
    const generation = this.#modelGeneration;
    const task: Promise<ModelDiscoveryResult> = discoverConnectionModels(env, [providerId]).then(result => {
      // A connection change while discovery ran makes this result untrustworthy.
      if (generation === this.#modelGeneration) this.#modelCache.set(providerId, { at: Date.now(), ok: result.diagnostics.length === 0, result });
      return result;
    }).finally(() => { if (this.#modelRefresh.get(providerId) === task) this.#modelRefresh.delete(providerId); });
    this.#modelRefresh.set(providerId, task);
    return task;
  }
  /** Drop cached discovery (connections changed). */
  #invalidateModels(): void { this.#modelGeneration += 1; this.#modelCache.clear(); this.#modelRefresh.clear(); }

  async #discoverModelsCached(env: ReturnType<typeof webRuntimeEnv>, ids: readonly string[], fresh: boolean): Promise<ModelDiscoveryResult & { pending?: true }> {
    const now = Date.now();
    let pending = false;
    const parts = await Promise.all(ids.map(async (id): Promise<ModelDiscoveryResult> => {
      const entry = this.#modelCache.get(id);
      if (!fresh && entry) {
        if (now - entry.at >= (entry.ok ? MODEL_CACHE_TTL_MS : MODEL_FAILURE_TTL_MS)) void this.#refreshModels(env, id).catch(() => undefined);
        return entry.result;
      }
      const task = this.#refreshModels(env, id);
      if (fresh) return task;
      // Cold: wait a bounded time so one slow provider cannot hold the whole picker.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const soft = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), MODEL_COLD_WAIT_MS); });
      const result = await Promise.race([task, soft]);
      clearTimeout(timer);
      if (result) return result;
      task.catch(() => undefined);
      pending = true;
      return { models: [], diagnostics: [{ providerId: id, message: "Model discovery is still running for this provider; reopen the picker in a moment." }] };
    }));
    return { models: parts.flatMap(part => part.models), diagnostics: parts.flatMap(part => part.diagnostics), ...(pending ? { pending: true as const } : {}) };
  }

  async #models(providerId?: string, expectedConnectionIdentity?: string, fresh = false) {
    if (providerId !== undefined) providerId = provider(providerId).id;
    assertPlanAllowed(providerId, { allowChatGptPlan: this.#allowChatGptPlan });
    const env = webRuntimeEnv();
    // Bind discovery to the same captured credentials/endpoint used to identify it.
    // Check before even public metadata synchronization can start network work.
    if (expectedConnectionIdentity !== undefined) {
      if (!providerId) throw new OperatorError(400, "provider_required", "Choose a provider for connection-bound model discovery.");
      const expected = text(expectedConnectionIdentity, "connection identity", 256);
      let actual: string | undefined;
      try { actual = connectionProbeRuntime(providerId, env).connectionIdentity(); } catch { /* Invalid or disconnected connection mismatches. */ }
      if (!actual || actual !== expected) throw new OperatorError(409, "model_connection_changed", "The model connection changed. Refresh Connections and try again.");
    }
    const ids = providerStates(env).filter(state => state.configured && (!providerId || state.id === providerId)).map(state => state.id);
    if (this.#allowChatGptPlan && (!providerId || providerId === "chatgpt-plan") && listChatGptPlanProfiles().some(p => p.active && p.status === "connected" && p.sharing)) ids.push("chatgpt-plan");
    // Public pricing/context metadata is not account entitlement and must not
    // block account discovery. Render from the existing cache/offline snapshot.
    if (!this.#catalogRefresh) {
      this.#catalogRefresh = Promise.resolve().then(() => syncModelCatalog())
        .catch(() => null).finally(() => { this.#catalogRefresh = undefined; });
    }
    const discovered = await this.#discoverModelsCached(env, ids, fresh);
    const metadata = new Map(buildFullModelCatalog().map(model => [`${model.provider}/${model.id}`, model]));
    const disabledByProvider = new Map<string, Set<string>>();
    const accountStore = loadAccountStore();
    const rows = discovered.models.map(model => ({
      id: model.id, provider: model.provider,
      enabled: !isModelDisabled(disabledByProvider.get(model.provider) ?? disabledByProvider.set(model.provider, disabledModelsFor(model.provider, accountStore)).get(model.provider)!, model.id),
      price: model.provider === "chatgpt-plan" ? "Shared ChatGPT allowance" : model.provider === "chatgpt-codex" ? "Included in subscription" : metadata.get(`${model.provider}/${model.id}`)?.price ?? "Unknown rate",
      contextWindowTokens: model.contextTokens ?? resolveContextLimit({ modelId: model.id, providerId: model.provider })?.tokens ?? null,
      source: model.provider !== "chatgpt-plan" && model.source === "catalog" ? "public-catalog" as const : "account" as const,
    }));
    // Custom OpenAI-compatible gateways may omit /models or publish an incomplete
    // catalog. The operator's configured ID remains selectable in either case.
    const configuredModel = env.OPENAI_MODEL;
    if (configuredModel && ids.includes("openai") && !rows.some(row => row.provider === "openai" && row.id === configuredModel)) {
      rows.unshift({ id: configuredModel, provider: "openai", enabled: !isModelDisabled(disabledModelsFor("openai", accountStore), configuredModel), price: "Unknown rate", contextWindowTokens: null, source: "account" });
    }
    return { models: rows, providerId: providerId ?? null,
      diagnostics: discovered.diagnostics.map(item => ({ ...item, message: publicMessage(item.message) })), roles: MODEL_ROLES,
      ...(discovered.pending ? { pending: true } : {}) };
  }

  async #connections(input: unknown) {
    const body = object(input);
    const info = provider(body.providerId);
    const action = text(body.action, "connection action", 32);
    assertPlanAllowed(info.id, { allowChatGptPlan: this.#allowChatGptPlan });
    if (info.id === "chatgpt-plan") {
      const id = text(body.accountId, "account ID", 128);
      if (action === "activate") await selectChatGptPlanProfile(id);
      else if (action === "disconnect") {
        this.#plan.cancel();
        const result = await signOutChatGptPlan(id);
        pruneConnectionMeta(info.id, id, undefined);
        return { providers: this.#providers(), revoked: result.revoked, message: result.revoked ? "Signed out locally and provider revocation completed." : "Signed out locally. Provider revocation could not be confirmed; review the connection in ChatGPT Settings." };
      } else throw new OperatorError(400, "unsupported_auth", "Use native ChatGPT browser sign-in.");
      return { providers: this.#providers() };
    }
    if (action === "configure") {
      const config = validateConnectionConfig(info.id, {
        ...(body.baseUrl !== undefined ? { baseUrl: text(body.baseUrl, "API endpoint") } : {}),
        ...(body.model !== undefined ? { model: text(body.model, "deployment model", 256) } : {}),
      });
      if (!Object.keys(config).length) throw new OperatorError(400, "empty_configuration", "Choose a supported connection configuration field to update.");
      saveConnectionConfig(info.id, { ...loadConnectionConfigs()[info.id], ...config });
      return { providers: this.#providers() };
    }
    let store = loadAccountStore();
    let disconnected: { accountId: string | undefined } | undefined;
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
      const removedAccountId = body.accountId === undefined ? undefined : text(body.accountId, "account ID", 128);
      store = removedAccountId === undefined ? logoutProvider(store, info.id) : removeAccount(store, info.id, removedAccountId);
      disconnected = { accountId: removedAccountId };
    } else if (action === "activate") {
      const accountId = text(body.accountId, "account ID", 128);
      if (!store.providers[info.id]?.accounts[accountId]) throw new OperatorError(404, "unknown_account", "Saved account does not exist.");
      if (info.envVars.some((key) => process.env[key]?.trim())) throw new OperatorError(409, "environment_owned", "The explicit server credential takes precedence over saved accounts.");
      store = setActiveAccount(store, info.id, accountId);
    } else throw new OperatorError(400, "invalid_action", "Unsupported connection action.");
    if (!saveAccountStore(store)) throw new OperatorError(500, "persistence_failed", "Could not save the private credential account store.");
    if (disconnected) pruneConnectionMeta(info.id, disconnected.accountId, Object.keys(store.providers[info.id]?.accounts ?? {}));
    return { providers: this.#providers() };
  }

  #deviceAuth(id: string, method: string, input?: unknown) {
    const info = provider(id);
    assertPlanAllowed(info.id, { allowChatGptPlan: this.#allowChatGptPlan });
    if (info.id === "chatgpt-plan") {
      const body = input === undefined ? {} : object(input);
      const profileId = body.profileId === undefined ? undefined : text(body.profileId, "profile ID", 128);
      return { status: method === "DELETE" ? this.#plan.cancel() : this.#plan.start(profileId) };
    }
    if (info.id === "chatgpt-codex") return { status: this.#publicAuth(method === "DELETE" ? this.#codex.cancel() : this.#codex.start()) };
    const config = PROVIDER_DEVICE_AUTH[info.id];
    if (!config) throw new OperatorError(409, "auth_unavailable", info.hint);
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
    const installed = await pluginService.list();
    const items = new Map(this.#registryItems);
    const errors = new Map<string, string>();
    for (const id of listInstalledPluginIds(pluginsRootDir())) {
      const discovered = readInstalledPlugin(pluginsRootDir(), id, { reservedToolNames });
      if (!discovered.ok) { errors.set(id, discovered.errors.join("; ")); continue; }
      const manifest = discovered.plugin.manifest;
      items.set(`plugin:${id}`, {
        id, kind: "plugin", name: manifest.name ?? id, version: manifest.version,
        description: manifest.tools.map((tool) => tool.name).join(", "),
        capabilities: aggregateCapabilities(manifest), signature: "unverified",
        raw: { local: true, toolCount: manifest.tools.length, source: readPluginSource(join(pluginsRootDir(), id)) },
      });
    }
    const host = pluginManager?.current();
    const hostStates = host?.status() ?? [];
    const loadedPluginIds = hostStates.filter((entry) => entry.state === "ready").map((entry) => entry.pluginId);
    const result = [...items.values()].map(({ raw, ...item }) => ({
      ...item, ...this.#metadata(item, raw), state: installed.plugins.get(item.id) ?? "available",
      loaded: loadedPluginIds.includes(item.id),
      error: errors.get(item.id) ?? (hostStates.some((state) => state.pluginId === item.id && state.state === "unavailable") ? "Plugin is unavailable in the current host." : null),
    }));
    for (const [id, error] of errors) if (!result.some((item) => item.id === id && item.kind === "plugin")) result.push({ id, kind: "plugin", name: id, version: "", toolCount: 0, skillCount: 0, logo: connectorLogo(id, id), source: "local" as const, description: "Installed manifest is invalid.", capabilities: [], signature: "unverified", state: "installed", loaded: false, error });
    return {
      registry: { url: publicRegistryUrl, available: fetched.ok, error: this.#registryError },
      items: result.map(item => ({ ...item, version: item.version || null, status: item.error ? "error" as const : item.state })), deferred: [...deferredPlugins], executionProfile: consoleExecutionProfile(),
      host: { loadedPluginIds, tools: host?.toolDefinitions().map(({ name, description }) => ({ name, description })) ?? [] },
    };
  }

  /** Uniform list metadata: tool/skill counts, status, source and a same-origin logo (never a remote URL). */
  #metadata(item: { kind: string; id: string; name: string; version: string }, raw: unknown) {
    const row = (raw && typeof raw === "object" ? raw : {}) as { local?: boolean; toolCount?: number; source?: { repo: string; ref: string | null; sha: string } | null; manifest?: { tools?: unknown[]; icon?: unknown }; icon?: unknown };
    const github = row.source ?? null;
    const iconUrl = row.icon ?? row.manifest?.icon;
    return {
      toolCount: row.toolCount ?? (Array.isArray(row.manifest?.tools) ? row.manifest!.tools!.length : 0),
      skillCount: 0, version: item.version || null,
      logo: iconUrl ? this.#icons.logoFor(item.id, item.name, iconUrl) : connectorLogo(item.id, item.name),
      source: github ? "github" as const : row.local ? "local" as const : "registry" as const,
      ...(github ? { repo: github.repo, sha: github.sha } : {}),
    };
  }

  async #pluginAction(action: string, input: unknown) {
    if (action === "run" && consoleExecutionProfile() === "smolvm") throw new OperatorError(409, "isolated_execution_required", "Plugins load automatically inside new SmolVM chats. Start a new chat to use an approved plugin.");
    const body = object(input);
    const id = text(body.id, "plugin ID", 64);
    if (action === "install") {
      // Always re-fetch validated install bytes; input never supplies executable content.
      await this.#plugins();
      if (this.#registryError) throw new OperatorError(503, "registry_unavailable", this.#registryError);
      const item = this.#registryItems.get(`plugin:${id}`);
      if (!item) throw new OperatorError(404, "unknown_artifact", "The configured registry has no installable artifact with that ID.");
      const result = await pluginService.install(item);
      if (!result.ok) throw new OperatorError(409, "install_failed", result.message);
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
      return consoleExecutionProfile() === "smolvm" ? { ...result, message: "Approved for new SmolVM chats. Plugin files are copied and loaded automatically inside each new VM." } : result;
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
    const servicePluginResult = await this.#servicePlugins.handle(path, method, input);
    if (servicePluginResult) return servicePluginResult;
    const mcpResult = await this.#customMcp.handle(path, method, input);
    if (mcpResult) return mcpResult;
    const githubResult = await this.#githubPlugins.handle(path, method, input);
    if (githubResult) return githubResult;
    const extrasResult = await this.#connectionExtras.handle(path, method, input);
    if (extrasResult) return extrasResult;
    if (!/^(providers(?:\/[^/]+(?:\/device-auth)?)?|models|connections|settings(?:\/reset)?|plugins(?:\/(?:install|enable|disable|run))?|doctor|update-status|tools|project(?:\/(?:directories|choose-directory))?|checks|feedback)$/.test(path)) return null;
    try {
      let data: unknown;
      let status = 200;
      if (path === "providers" && method === "GET") data = { providers: this.#providers(), preference: getSettings().modelPreference };
      else if (path === "models" && method === "GET") data = await this.#models(query.get("providerId") ?? undefined, query.get("expectedConnectionIdentity") ?? undefined, query.get("fresh") === "1");
      else if (path === "connections" && method === "POST") { this.#invalidateModels(); try { data = await this.#connections(input); } finally { this.#invalidateModels(); } }
      else if (/^providers\/[^/]+\/device-auth$/.test(path) && ["POST", "DELETE"].includes(method)) {
        this.#invalidateModels(); data = this.#deviceAuth(decodeURIComponent(path.split("/")[1]!), method, input); status = method === "POST" ? 202 : 200;
      } else if (/^providers\/[^/]+$/.test(path) && method === "GET") {
        const info = provider(decodeURIComponent(path.split("/")[1]!));
        assertPlanAllowed(info.id, { allowChatGptPlan: this.#allowChatGptPlan });
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
        if (internalBoolean ? typeof body.value !== "boolean" : def!.kind === "boolean" ? typeof body.value !== "boolean" : def!.kind === "number" ? !Number.isInteger(body.value) || (body.value as number) < def!.min! || (body.value as number) > def!.max! : def!.kind === "text" ? typeof body.value !== "string" || body.value.length > def!.maxLength! : typeof body.value !== "string" || !def!.choices?.includes(body.value)) throw new OperatorError(400, "invalid_value", "The value is not supported by this setting.");
        const persisted = updateSetting(key as keyof TuiSettings, body.value as TuiSettings[keyof TuiSettings], { scope: body.scope as "global" | "project" | undefined });
        data = { ...settingsView(), persisted, ...(!persisted ? { error: "Settings changed in this process but could not be saved to disk.", code: "persistence_failed" } : {}) };
        if (!persisted) status = 507;
      } else if (path === "settings/reset" && method === "POST") {
        const body = object(input);
        const explicit = body.keys !== undefined;
        const keys = body.keys ?? SETTING_DEFS.map((def) => def.key);
        if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !SETTING_DEFS.some((def) => def.key === key))) throw new OperatorError(400, "invalid_setting", "Reset keys must name declared settings.");
        const plan = planSettingsReset(keys as Array<keyof TuiSettings>, explicit, getSettings());
        const persisted = plan.keys.length ? resetSettings(DEFAULT_SETTINGS, plan.keys) : true;
        data = { ...settingsView(), persisted, preserved: plan.preserved, ...(!persisted ? { error: "Settings reset in this process but could not be saved to disk.", code: "persistence_failed" } : {}) };
        if (!persisted) status = 507;
      } else if (path === "plugins" && method === "GET") data = await this.#plugins();
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
      } else if (path === "update-status" && method === "GET") data = readUpdateStatus({ current: VERSION, policy: getSettings().updatePolicy });
      else if (path === "tools" && method === "GET") {
        const roleTools: Record<string, Set<string>> = Object.fromEntries(MODEL_ROLES.map((role) => [role, new Set(getToolsForRole(role, { hasScope: true, webMode: true, hasBrowser: true, allowScanners: true }).map((tool) => tool.name))]));
        data = { roles: MODEL_ROLES, tools: Object.values(TOOL_DEFINITIONS).map(({ name, description }) => ({ name, description, roles: MODEL_ROLES.filter((role) => roleTools[role]!.has(name)) })), plugins: pluginManager?.current().toolDefinitions().map(({ name, description }) => ({ name, description })) ?? [] };
      } else if (path === "project/choose-directory" && method === "POST") {
        data = await chooseWorkspaceFolder(object(input).path);
      } else if (path === "project/directories" && method === "POST") {
        data = await listWorkspaceDirectories(object(input).path);
      } else if (path === "project" && method === "GET") {
        const projectPath = realpathSync(resolve(query.get("path") ?? process.cwd()));
        if (!statSync(projectPath).isDirectory()) throw new OperatorError(400, "invalid_project", "Project path must name a local directory.");
        const git: { root: string | null; branch: string | null; dirty: boolean; error: string | null } = { root: null, branch: null, dirty: false, error: null };
        try {
          git.root = execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", projectPath, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
          git.branch = execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", projectPath, "branch", "--show-current"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
          git.dirty = Boolean(execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", projectPath, "status", "--porcelain"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1_048_576 }).trim());
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
    this.#plan.cancel();
    this.#codex.cancel();
    for (const flow of this.#auth.values()) flow.session?.cancel();
    pluginManager?.dispose();
  }
}
