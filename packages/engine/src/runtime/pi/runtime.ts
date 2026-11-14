/**
 * PiAiRuntime: a `NativeRuntime` (and legacy `Runtime`) implemented on top of
 * `@earendil-works/pi-ai`. Opt-in (`ZERO_RUNTIME=pi-ai`); the hand-written
 * `LlmApiRuntime` stays the default.
 *
 * Phase 1 scope: API-key providers only (Anthropic, OpenAI, OpenAI-compatible
 * base URLs incl. OpenRouter/Ollama, Google Gemini API). Out of scope and
 * refused at construction/availability time: subscription OAuth (provider
 * terms unverified), Codex/Copilot/Cline/Azure/OpenCode/z-ai/kimi/qwen routes,
 * cyber-access programs, granted transports, cross-provider failover.
 *
 * Contract kept from `NativeRuntime.executeNative`:
 *  - an already-aborted signal makes NO request;
 *  - operator cancellation is terminal: never retried, reported as
 *    `cancelled: true` (stopReason stays "error");
 *  - the runtime's own timeout is reported as `timedOut: true`, never `cancelled`;
 *  - usage.inputTokens is the TOTAL prompt (uncached + cache reads + writes).
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Models,
  ModelsRequestTransforms,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type {
  NativeMessage,
  NativeRuntime,
  NativeRuntimeResult,
  NativeStreamCallbacks,
  NativeToolDef,
  CyberAccessProgram,
  Runtime,
  RuntimeConfig,
  RuntimeContext,
  RuntimeResult,
  SubagentModelSelection,
} from "../types.js";
import type { SiwcConnection } from "../siwc-connection.js";
import type { CodexCatalogModel } from "../codex-models.js";
import type { PrivateWorkerRuntimeBinding } from "../llm-api/runtime.js";
import { completionTokenLimit } from "../llm-api/usage-parsing.js";
import { QuotaExhaustedError, composeCallAbort, llmStreamMaxAttempts } from "../llm-api/retry.js";
import { getFallbackChain, resolveFailoverProvider, type ApiProviderConnection, type FallbackEntry } from "../llm-api/fallback.js";
import { isLocalAdmissionFailure, type RequestAdmission } from "../request-admission.js";
import { diag } from "../../diagnostics/channel.js";
import { createPolicyFetch, type FailoverReason, type PolicyState } from "./policy.js";
import { defaultReasoningEffort, normalizeModelForProvider, parseCodexAzureConfig, type ApiProvider } from "../llm-api/provider-config.js";
import { AUTO_MODEL_SENTINEL, DEFAULT_PROVIDER_MODELS, type ApiRuntimeDiagnostics } from "../llm-api/provider-detect.js";
import { fromPiAssistant, mapPiStopReason, mapPiUsage, toPiContext, type PiTargetIdentity } from "./convert.js";
import { buildPiRoute, resolvePiRoute, routeForModel, type PiRoute } from "./route.js";

/** Env flag value that selects this runtime. */
export const PI_RUNTIME_ENV_KEY = "ZERO_RUNTIME";
export const PI_RUNTIME_ENV_VALUE = "pi-ai";

/** True when the operator opted into the pi-ai runtime (config.env wins over process env). */
export function isPiRuntimeSelected(env: Readonly<Record<string, string | undefined>> = process.env, override?: Readonly<Record<string, string | undefined>>): boolean {
  return (override?.[PI_RUNTIME_ENV_KEY] ?? env[PI_RUNTIME_ENV_KEY])?.trim().toLowerCase() === PI_RUNTIME_ENV_VALUE;
}

export interface PiAiRuntimeOptions {
  /** Test seam / advanced: a prepared pi `Models` collection. Default: built lazily from built-in providers. */
  models?: Models;
  /** Test seam: skip route resolution and use this exact model (e.g. a faux model). */
  model?: Model<Api>;
  /** Pre-resolved route (used by forks so they never rediscover credentials). */
  route?: PiRoute;
  /** Use `config.env` exactly (worker rehydration): never merge ambient process env. */
  sealedEnv?: boolean;
  /**
   * Extra pi request options merged into every call: `headers`, `onPayload`,
   * pi's `transformHeaders` hook, or a base `fetch` (the policy fetch wraps it).
   */
  requestOptions?: Partial<SimpleStreamOptions> & ModelsRequestTransforms;
}

const PI_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function thinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  const v = value?.trim().toLowerCase();
  return PI_LEVELS.find((l) => l === v);
}

export class PiAiRuntime implements Runtime, NativeRuntime {
  readonly type = "api" as const;

  private config: RuntimeConfig;
  private env: Readonly<NodeJS.ProcessEnv>;
  private route?: PiRoute;
  private routeError?: Error;
  private fixedModel?: Model<Api>;
  private models?: Models;
  private modelsPromise?: Promise<Models>;
  private materialized?: { key: string; model: Model<Api> };
  private readonly requestOptions: Partial<SimpleStreamOptions> & ModelsRequestTransforms;
  private readonly admissionCache = new Map<string, Promise<RequestAdmission>>();
  /** Ordered ZERO_LLM_FALLBACK chain (root runtimes only; forks never get cross-account authority). */
  private fallbackChain: Array<FallbackEntry & { credentials?: ApiProviderConnection }> = [];
  private fallbackIndex = 0;
  private readonly conversationId = randomUUID();
  private reasoningEffort?: string;
  private lastCostUsd = 0;
  private totalCostUsd = 0;

  constructor(config: RuntimeConfig, options: PiAiRuntimeOptions = {}) {
    this.config = { ...config, ...(config.agentModels ? { agentModels: Object.freeze({ ...config.agentModels }) } : {}) };
    this.env = Object.freeze(options.sealedEnv ? { ...config.env } : { ...process.env, ...config.env });
    this.models = options.models;
    this.fixedModel = options.model;
    this.requestOptions = options.requestOptions ?? {};
    if (options.route) this.route = options.route;
    else if (!options.model) this.resolveRoute();
  }

  private resolveRoute(): void {
    try {
      this.route = resolvePiRoute(this.config, this.env);
      this.routeError = undefined;
      this.fallbackChain = getFallbackChain(this.env).map((entry) => ({ ...entry, credentials: resolveFailoverProvider(entry.provider, entry.model, this.env) }));
      this.fallbackIndex = 0;
    } catch (error) {
      this.route = undefined;
      this.routeError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // ── identity ──────────────────────────────────────────────────────────

  get outputTokenLimit(): number | undefined {
    return completionTokenLimit(this.env);
  }

  resolvedModel(): string {
    return this.fixedModel?.id ?? this.route?.model ?? this.config.model ?? "";
  }

  resolvedProvider(): string {
    return this.route?.zeroProvider ?? this.fixedModel?.provider ?? this.config.provider ?? "pi-ai";
  }

  resolvedPricingModel(): string {
    const provider = this.resolvedProvider();
    const model = this.resolvedModel();
    return provider === "google" ? model : `${provider}/${model}`;
  }

  modelSelection(): { agentModels: Record<string, string>; singleModel: boolean; autoRoute: boolean } {
    return {
      agentModels: { ...this.config.agentModels },
      singleModel: this.config.singleModel === true,
      autoRoute: this.config.autoRoute === true,
    };
  }

  accessibleModels(): string[] {
    const model = this.resolvedModel();
    return model ? [model] : [];
  }

  /** pi's own cost estimate for the most recent request (USD). Diagnostic; billing stays on our ledger. */
  lastRequestCostUsd(): number { return this.lastCostUsd; }
  /** Sum of pi cost estimates over this runtime's lifetime (USD). */
  totalRequestCostUsd(): number { return this.totalCostUsd; }

  /** Same shape as `LlmApiRuntime.getConfigurationDiagnostics()`, so pre-flight checks work on either runtime. */
  getConfigurationDiagnostics(): ApiRuntimeDiagnostics {
    if (this.fixedModel || (this.route && this.route.apiKey.length > 0)) {
      return { valid: true, provider: (this.resolvedProvider() as ApiProvider), providerLabel: this.route?.label ?? "pi-ai" };
    }
    const message = this.routeError?.message ?? "pi-ai runtime has no usable provider route";
    return {
      valid: false,
      provider: (this.config.provider ?? "anthropic") as ApiProvider,
      providerLabel: "pi-ai",
      reason: /api key|credential/i.test(message) ? "missing_key" : "invalid_config",
      fatalError: message,
    };
  }

  // ── console surface (API-key routes) ──────────────────────────────────
  // The web console manages connections through these; semantics mirror LlmApiRuntime
  // so saved preferences keyed by connection identity keep working across runtimes.

  /** Non-secret identity hash; identical to LlmApiRuntime's for the same provider/baseUrl/key. */
  connectionIdentity(): string | undefined {
    if (!this.route || !this.route.apiKey) return undefined;
    return createHash("sha256").update(JSON.stringify([this.route.zeroProvider, this.route.rawBaseUrl, this.route.apiKey])).digest("hex");
  }

  reasoningConfiguration(): { effort: string; options: string[] } | null {
    if (!this.route || this.route.api !== "openai-responses" || !["openai", "azure"].includes(this.route.zeroProvider)) return null;
    const model = this.route.model.replace(/^openai\//, "");
    let options: string[];
    if (/^gpt-(?:6-astra|6\.1-sol)(?:-20\d\d-\d\d-\d\d)?$/.test(model)) options = ["low", "medium", "high", "xhigh", "max"];
    else if (/^gpt-(?:6-sol|6-luna|5\.6(?:-sol|-terra|-luna)?)(?:-20\d\d-\d\d-\d\d)?$/.test(model)) options = ["none", "low", "medium", "high", "xhigh", "max"];
    else return null;
    const effort = this.reasoningEffort ?? defaultReasoningEffort(this.route.model) ?? "medium";
    return options.includes(effort) ? { effort, options } : null;
  }

  setReasoningEffort(effort: string): void {
    const configuration = this.reasoningConfiguration();
    if (!configuration || !configuration.options.includes(effort)) throw new Error("This reasoning effort is not supported by the selected model and connection.");
    this.reasoningEffort = effort;
  }

  async codexModelCatalog(_signal?: AbortSignal): Promise<CodexCatalogModel[]> {
    throw new Error("No active Codex subscription");
  }

  async availableModelCatalog(signal?: AbortSignal): Promise<Array<{ id: string; contextTokens?: number; source?: "catalog" }>> {
    if (!this.route) throw new Error(this.routeError?.message ?? "pi-ai runtime has no usable provider route");
    const route = this.route;
    const { discoverProviderModels } = await import("../provider-model-discovery.js");
    const headers: Record<string, string> = route.piProvider === "anthropic"
      ? { "x-api-key": route.apiKey, "anthropic-version": "2023-06-01" }
      : route.piProvider === "google" ? { "x-goog-api-key": route.apiKey } : { Authorization: `Bearer ${route.apiKey}` };
    return discoverProviderModels({ provider: route.zeroProvider as ApiProvider, baseUrl: route.rawBaseUrl, headers, signal,
      ...(route.zeroProvider === "together" && this.env["TOGETHER_MODEL_LIST"]?.trim().toLowerCase() === "all" ? { listAll: true } : {}) });
  }

  publishedContextWindowTokens(): number | undefined {
    return undefined;
  }

  accessibleProviders(): ApiProvider[] {
    const out: ApiProvider[] = [];
    for (const provider of Object.keys(DEFAULT_PROVIDER_MODELS) as ApiProvider[]) {
      if (resolveFailoverProvider(provider, DEFAULT_PROVIDER_MODELS[provider] || "probe", this.env)) out.push(provider);
    }
    return out;
  }

  refreshConnection(env: NodeJS.ProcessEnv): void {
    const effort = this.reasoningEffort;
    const merged: RuntimeConfig = {
      ...this.config, apiKey: undefined, provider: (this.route?.zeroProvider ?? this.config.provider) as RuntimeConfig["provider"],
      model: this.resolvedModel(), env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
    };
    const nextEnv = Object.freeze({ ...process.env, ...merged.env });
    const route = resolvePiRoute(merged, nextEnv);
    this.config = merged; this.env = nextEnv; this.route = route; this.routeError = undefined;
    this.fallbackChain = getFallbackChain(nextEnv).map((entry) => ({ ...entry, credentials: resolveFailoverProvider(entry.provider, entry.model, nextEnv) }));
    this.fallbackIndex = 0;
    this.admissionCache.clear();
    this.reasoningEffort = effort;
  }

  useGrantedProviderTransport(): void {
    throw new Error("pi-ai runtime does not support granted provider transports");
  }

  workbenchCredentialResolver(): () => Promise<{ accessToken: string; accountId?: string }> {
    throw new Error("Host workbench credential broker requires a captured chatgpt-codex account");
  }

  setCyberAccessProgram(value: CyberAccessProgram | null): void {
    if (value !== null) throw new Error("Cyber access program requires explicit OpenAI API or ChatGPT Codex OAuth provider and its supported Responses endpoint.");
  }
  getCyberAccessProgram(): CyberAccessProgram | undefined { return undefined; }
  cyberAccessProgramConfiguration(): { confirmed?: CyberAccessProgram; requested?: CyberAccessProgram; options: CyberAccessProgram[]; unavailableReason?: string } {
    return { options: [], unavailableReason: "This runtime does not support explicit cyber access programs." };
  }

  /** Credential-bearing; send only over a private host-worker pipe. Shape matches LlmApiRuntime's binding. */
  exportPrivateWorkerBinding(): PrivateWorkerRuntimeBinding {
    const route = this.route;
    const identity = this.connectionIdentity();
    if (!route || !identity) throw new Error("The selected runtime has no captured connection identity.");
    const env = Object.fromEntries(Object.entries(this.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && /^(?:(?:OPENAI|OPENROUTER|ANTHROPIC|AZURE_OPENAI|DEEPSEEK|Z_AI|KIMI|QWEN|XAI|OPENCODE|CLINE|TOGETHER|COPILOT|GOOGLE|GEMINI)_|ZERO_(?:CHATGPT_|GEMINI_|COPILOT_|LLM_|REASONING_|REGION_OVERRIDE$|ZAI_THINKING_BUDGET$|MODEL$|SELECTED_PROVIDER$|FORCE_PROVIDER$|PROVIDER$|REQUIRE_|SUPPRESS_PROVIDER_STARTUP_LOG$|RUNTIME$))/.test(entry[0])));
    const config: RuntimeConfig = { type: "api", timeout: this.config.timeout, provider: route.zeroProvider as RuntimeConfig["provider"], model: route.model, ...this.modelSelection() };
    return structuredClone({
      config, env, provider: route.zeroProvider as ApiProvider, apiKey: route.apiKey, baseUrl: route.rawBaseUrl, model: route.model,
      wireApi: route.api === "openai-responses" ? "responses" as const : "chat_completions" as const,
      reasoningEffort: this.reasoningEffort, azureConfig: parseCodexAzureConfig({}),
      fallbackChain: this.fallbackChain, fallbackIndex: this.fallbackIndex, identity,
      opencodeConversationId: `ses_${this.conversationId}`, runtimeKind: "pi-ai" as const,
    });
  }

  /** Rehydrate a trusted private-pipe binding without auth discovery or ambient defaults. */
  static fromPrivateWorkerBinding(binding: PrivateWorkerRuntimeBinding, options: PiAiRuntimeOptions = {}): PiAiRuntime {
    const sealed = structuredClone(binding);
    if (sealed.runtimeKind !== "pi-ai" || !/^ses_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sealed.opencodeConversationId) || !sealed.identity
      || sealed.config.type !== "api" || sealed.config.model !== sealed.model || sealed.config.provider !== sealed.provider || !Number.isFinite(sealed.config.timeout) || sealed.config.timeout <= 0) {
      throw new Error("Invalid host worker runtime binding.");
    }
    const route = buildPiRoute(sealed.provider, { apiKey: sealed.apiKey, baseUrl: sealed.baseUrl, wireApi: sealed.wireApi }, sealed.model);
    const runtime = new PiAiRuntime({ ...sealed.config, env: sealed.env }, { ...options, route, sealedEnv: true });
    Object.defineProperty(runtime, "conversationId", { value: sealed.opencodeConversationId.slice(4) });
    runtime.fallbackChain = sealed.fallbackChain;
    runtime.fallbackIndex = sealed.fallbackIndex;
    runtime.reasoningEffort = sealed.reasoningEffort;
    if (runtime.connectionIdentity() !== sealed.identity) throw new Error("Host worker connection identity does not match the captured session.");
    return runtime;
  }

  /** Apply a checkpoint only to the same live account/selection (host verifies its epoch first). */
  applyPrivateWorkerBinding(binding: PrivateWorkerRuntimeBinding, options?: { replaceSelection: true }): void {
    const candidate = PiAiRuntime.fromPrivateWorkerBinding(binding);
    if (!options?.replaceSelection && (candidate.connectionIdentity() !== this.connectionIdentity() || candidate.resolvedProvider() !== this.resolvedProvider()
      || candidate.resolvedModel() !== this.resolvedModel() || candidate.conversationId !== this.conversationId)) {
      throw new Error("Worker checkpoint does not match the current session connection and model.");
    }
    if (options?.replaceSelection) {
      Object.defineProperty(this, "conversationId", { value: candidate.conversationId });
      this.config = candidate.config;
      this.reasoningEffort = candidate.reasoningEffort;
    }
    this.env = candidate.env; this.route = candidate.route; this.routeError = undefined;
    this.fallbackChain = candidate.fallbackChain; this.fallbackIndex = candidate.fallbackIndex;
    this.admissionCache.clear();
  }

  async isAvailable(): Promise<boolean> {
    return this.fixedModel !== undefined || (this.route !== undefined && this.route.apiKey.length > 0);
  }

  // ── selection / forks ─────────────────────────────────────────────────

  reconfigure(sel: {
    siwcConnection?: SiwcConnection;
    model?: string;
    provider?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
    autoRoute?: boolean;
    env?: NodeJS.ProcessEnv;
  }): void {
    if (sel.siwcConnection) throw new Error("pi-ai runtime does not support ChatGPT plan connections");
    const next: RuntimeConfig = {
      ...this.config,
      ...(sel.agentModels !== undefined ? { agentModels: Object.freeze({ ...sel.agentModels }) } : {}),
      ...(sel.singleModel !== undefined ? { singleModel: sel.singleModel } : {}),
      ...(sel.autoRoute !== undefined ? { autoRoute: sel.autoRoute } : {}),
    };
    const providerChanged = sel.provider !== undefined && sel.provider !== this.config.provider && sel.provider !== this.route?.zeroProvider;
    if (providerChanged || sel.env !== undefined) {
      const merged: RuntimeConfig = {
        ...next,
        // Never carry a previous connection's explicit key to a new provider.
        ...(providerChanged ? { apiKey: undefined } : {}),
        provider: (sel.provider ?? next.provider) as RuntimeConfig["provider"],
        model: sel.model ?? (providerChanged ? undefined : next.model),
        ...(sel.env !== undefined ? { env: sel.env as Record<string, string> } : {}),
      };
      const env = Object.freeze({ ...process.env, ...merged.env });
      const route = resolvePiRoute(merged, env); // throws before any state changes
      this.config = merged; this.env = env; this.route = route; this.routeError = undefined; this.fixedModel = undefined;
      this.fallbackChain = getFallbackChain(env).map((entry) => ({ ...entry, credentials: resolveFailoverProvider(entry.provider, entry.model, env) }));
      this.fallbackIndex = 0;
      this.admissionCache.clear();
      return;
    }
    if (sel.model !== undefined && this.route) {
      const model = normalizeModelForProvider(this.route.zeroProvider as ApiProvider, sel.model);
      this.route = routeForModel(this.route, model);
      next.model = model;
    }
    this.config = next;
  }

  async forkForSubagent(timeoutMs: number, selection?: SubagentModelSelection): Promise<PiAiRuntime> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Subagent timeout must be a positive finite number");
    const parentModel = this.resolvedModel();
    const roleModel = selection?.role !== undefined && this.config.agentModels && Object.hasOwn(this.config.agentModels, selection.role)
      ? this.config.agentModels[selection.role]
      : undefined;
    const autoInEffect = roleModel === AUTO_MODEL_SENTINEL || (this.config.autoRoute === true && roleModel === undefined);
    const configuredModel = roleModel === AUTO_MODEL_SENTINEL ? undefined : roleModel;
    const selectedModel = this.config.singleModel ? parentModel : selection?.model ?? configuredModel ?? parentModel;
    if (typeof selectedModel !== "string" || !selectedModel.trim()) throw new Error("Subagent model must be a non-empty model ID");
    const provider = this.route?.zeroProvider as ApiProvider | undefined;
    const model = selectedModel === parentModel || !provider ? selectedModel : normalizeModelForProvider(provider, selectedModel);
    const approved = model === parentModel || Object.values(this.config.agentModels ?? {}).some(
      (id) => id !== AUTO_MODEL_SENTINEL && (provider ? normalizeModelForProvider(provider, id) : id) === model,
    );
    // Phase 1 has a single account/provider per runtime, so "auto" can only
    // reach the parent's own model; an unlisted model is refused like the default runtime does.
    if (!approved) {
      throw new Error(autoInEffect
        ? `Subagent model "${selectedModel}" is not reachable: pi-ai runtime serves a single provider connection.`
        : `Subagent model "${selectedModel}" is not operator-approved. Configure agentModels before selecting it.`);
    }
    const child = new PiAiRuntime(
      { ...this.config, timeout: Math.min(timeoutMs, this.config.timeout || 120_000), model },
      {
        ...(this.models ? { models: this.models } : {}),
        requestOptions: this.requestOptions,
        ...(this.fixedModel ? { model: this.fixedModel.id === model ? this.fixedModel : { ...this.fixedModel, id: model, name: model } } : {}),
        ...(this.route ? { route: routeForModel(this.route, model) } : {}),
      },
    );
    return child;
  }

  // ── model materialization ─────────────────────────────────────────────

  private async getModels(): Promise<Models> {
    if (this.models) return this.models;
    this.modelsPromise ??= (async () => {
      const { createModels } = await import("@earendil-works/pi-ai");
      const models = createModels();
      const [{ anthropicProvider }, { openaiProvider }, { googleProvider }, { openrouterProvider }] = await Promise.all([
        import("@earendil-works/pi-ai/providers/anthropic"),
        import("@earendil-works/pi-ai/providers/openai"),
        import("@earendil-works/pi-ai/providers/google"),
        import("@earendil-works/pi-ai/providers/openrouter"),
      ]);
      models.setProvider(anthropicProvider());
      models.setProvider(openaiProvider());
      models.setProvider(googleProvider());
      models.setProvider(openrouterProvider());
      this.models = models;
      return models;
    })();
    return this.modelsPromise;
  }

  private async materialize(route: PiRoute): Promise<{ models: Models; model: Model<Api> }> {
    const models = await this.getModels();
    const key = `${route.piProvider}|${route.api}|${route.baseUrl}|${route.model}`;
    if (this.materialized?.key === key) return { models, model: this.materialized.model };
    let model: Model<Api>;
    const catalog = route.piProvider === "openai-compat" ? undefined : models.getModel(route.piProvider, route.model);
    if (catalog && catalog.api === route.api) {
      model = catalog.baseUrl === route.baseUrl ? catalog : { ...catalog, baseUrl: route.baseUrl };
    } else {
      model = {
        id: route.model, name: route.model, api: route.api, provider: route.piProvider, baseUrl: route.baseUrl,
        // Unknown ids: no price table (our ledger prices from tokens anyway) and a conservative context window.
        reasoning: defaultReasoningEffort(route.model) !== undefined, input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: completionTokenLimit(this.env),
      } as Model<Api>;
    }
    if (route.piProvider === "openai-compat" && !models.getProvider("openai-compat")?.getModels().some((m) => m.id === model.id && m.baseUrl === model.baseUrl && m.api === model.api)) {
      const [{ createProvider }, { openAICompletionsApi }, { openAIResponsesApi }] = await Promise.all([
        import("@earendil-works/pi-ai"),
        import("@earendil-works/pi-ai/api/openai-completions.lazy"),
        import("@earendil-works/pi-ai/api/openai-responses.lazy"),
      ]);
      const provider = createProvider({
        id: "openai-compat", name: "OpenAI-compatible", baseUrl: route.baseUrl,
        auth: { apiKey: { name: "OpenAI-compatible", resolve: async () => ({ auth: {} }) } },
        models: [model],
        api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi() },
      });
      (models as unknown as { setProvider(p: unknown): void }).setProvider(provider);
    }
    this.materialized = { key, model };
    return { models, model };
  }

  // ── NativeRuntime ─────────────────────────────────────────────────────

  private cancelledResult(start: number, label: string): NativeRuntimeResult {
    return {
      content: [{ type: "text", text: "" }], stopReason: "error", cancelled: true,
      durationMs: Date.now() - start, error: `${label} request cancelled by operator`,
    };
  }

  /** Public entry point: one attempt loop (with cross-provider failover) plus the retry-safe receipt contract. */
  async executeNative(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult> {
    const result = await this.executeWithFailover(system, messages, tools, callbacks, signal);
    if (isLocalAdmissionFailure(result.error)) return result;
    if (this.env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] === "1" && (result.stopReason === "error" || result.error)) {
      return { ...result, error: `${result.error ?? "Incomplete gateway response"}. Request outcome may be unknown. Automatic replay is disabled` };
    }
    return result;
  }

  /** Advance ZERO_LLM_FALLBACK to the next usable pi-served entry. Operator cancellation never reaches here. */
  private tryFailover(reason: FailoverReason): boolean {
    if (this.config.cyberAccessProgram !== undefined) return false;
    while (this.fallbackIndex < this.fallbackChain.length) {
      const entry = this.fallbackChain[this.fallbackIndex++]!;
      if (!entry.credentials) {
        diag.warn("failover_provider_skipped", `ZERO_LLM_FALLBACK: skipping ${entry.provider} (auth env missing)`, { provider: entry.provider, model: entry.model, cause: "auth-env-missing" });
        continue;
      }
      let route: PiRoute;
      try {
        route = buildPiRoute(entry.provider, entry.credentials, normalizeModelForProvider(entry.provider, entry.model));
      } catch {
        diag.warn("failover_provider_skipped", `ZERO_LLM_FALLBACK: skipping ${entry.provider} (not served by the pi-ai runtime)`, { provider: entry.provider, model: entry.model, cause: "unsupported-by-pi-ai" });
        continue;
      }
      this.route = route;
      this.admissionCache.clear();
      diag.warn("failover_engaged", `${reason} — failover to ${entry.provider} (${route.model})`, { reason, provider: entry.provider, model: route.model });
      return true;
    }
    return false;
  }

  private async executeWithFailover(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult> {
    for (;;) {
      const outcome = await this.executeAttempt(system, messages, tools, callbacks, signal);
      if (outcome !== "failover") return outcome;
    }
  }

  private async executeAttempt(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult | "failover"> {
    const start = Date.now();
    const label = this.route?.label ?? "pi-ai";
    if (!this.fixedModel && !this.route) {
      return { content: [{ type: "text", text: "" }], stopReason: "error", durationMs: 0, error: this.routeError?.message ?? "pi-ai runtime has no usable provider route" };
    }
    // Already cancelled: no request, no timer, no model materialization.
    if (signal?.aborted) return this.cancelledResult(start, label);

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.config.timeout || 120_000);
    const call = composeCallAbort(timeout.signal, signal);
    const apiKey = this.route?.apiKey ?? this.config.apiKey ?? "test-key";
    const redact = (text: string): string => (apiKey.length >= 8 ? text.split(apiKey).join("[redacted]") : text);
    const state: PolicyState = {};
    try {
      const { models, model } = this.fixedModel
        ? { models: await this.getModels(), model: this.fixedModel }
        : await this.materialize(this.route!);
      const target: PiTargetIdentity = { provider: model.provider, api: model.api, model: model.id };
      const context = toPiContext(system, messages, tools, target);
      const effort = thinkingLevel(this.reasoningEffort) ?? thinkingLevel(this.env["ZERO_REASONING_EFFORT"]) ?? thinkingLevel(defaultReasoningEffort(model.id));
      const baseFetch = this.requestOptions.fetch;
      const options: SimpleStreamOptions & ModelsRequestTransforms = {
        ...this.requestOptions,
        apiKey,
        signal: call.signal,
        sessionId: this.conversationId,
        maxTokens: Math.min(model.maxTokens, completionTokenLimit(this.env, model.maxTokens), this.requestOptions.maxTokens ?? Number.POSITIVE_INFINITY),
        // Retry/backoff/failover live in the policy fetch (one budget, our semantics); pi's SDK-level retry is off.
        maxRetries: 0,
        fetch: createPolicyFetch({
          env: this.env, label, baseUrl: this.route?.baseUrl ?? model.baseUrl, state, signal: call.signal, operatorAborted: () => call.operatorAborted(),
          tryFailover: (reason) => this.tryFailover(reason), admissionCache: this.admissionCache,
          ...(baseFetch ? { baseFetch } : {}),
        }),
        // pi owns Anthropic cache_control breakpoint placement; "short" is its 5-minute tier (our 1.25x write rate).
        ...(model.provider === "anthropic" ? { cacheRetention: "short" as const } : {}),
        // Attribution headers the default runtime sends to OpenRouter.
        ...(this.route?.zeroProvider === "openrouter" ? { headers: { ...this.requestOptions.headers, "HTTP-Referer": "https://0.security", "X-Title": "0 Security Scanner" } } : {}),
        ...(model.reasoning && effort ? { reasoning: effort } : {}),
      };

      const maxAttempts = this.env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] === "1" ? 1 : llmStreamMaxAttempts();
      let final: AssistantMessage | undefined;
      for (let attempt = 1; ; attempt++) {
        let emitted = false;
        const stream = models.streamSimple(model, context, options);
        for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
          switch (event.type) {
            case "text_delta":
              emitted = true;
              if (event.delta) callbacks?.onDelta?.("assistant_response", event.delta);
              break;
            case "thinking_delta":
              emitted = true;
              if (event.delta) callbacks?.onDelta?.("reasoning", event.delta);
              break;
            case "thinking_end": {
              const text = event.content.trim();
              if (text) callbacks?.onThinking?.(text);
              break;
            }
            case "toolcall_start":
              emitted = true;
              break;
            case "done": final = event.message; break;
            case "error": final = event.error; break;
            default: break;
          }
        }
        final ??= await stream.result();
        // A fallback entry was engaged inside the fetch layer: re-issue the whole request on the new route.
        if (state.failover && !call.operatorAborted() && !signal?.aborted) return "failover";
        const unknownOutcome = /automatic replay (?:is )?disabled|outcome.{0,30}unknown/i.test(state.failure?.message ?? final.errorMessage ?? "");
        const transient = final.stopReason === "error" && !state.failure && state.httpStatus === undefined && !unknownOutcome && !call.operatorAborted() && !signal?.aborted
          && !timeout.signal.aborted && !emitted && attempt < maxAttempts && (await isRetryable(final));
        if (!transient) break;
        final = undefined;
        await sleep(attempt === 1 ? 500 : 1000, call.signal);
        if (call.signal.aborted) break;
      }
      if (!final) return call.operatorAborted() ? this.cancelledResult(start, label) : this.errorResult(start, label, "request aborted", timeout.signal.aborted);

      const usage = mapPiUsage(final.usage);
      const cost = final.usage.cost?.total ?? 0;
      this.lastCostUsd = cost;
      this.totalCostUsd += cost;
      if (usage.inputTokens > 0 || usage.outputTokens > 0) callbacks?.onUsage?.(usage);

      if (final.stopReason === "aborted" || final.stopReason === "error") {
        if (call.operatorAborted()) return this.cancelledResult(start, label);
        if (state.failure) return this.failureResult(start, label, state.failure, redact, timeout.signal.aborted);
        return this.errorResult(start, label, redact(final.errorMessage ?? "unknown error"), timeout.signal.aborted, usage);
      }
      // Operator pressed Esc after the provider finished but before we returned: honour it.
      if (call.operatorAborted()) return this.cancelledResult(start, label);

      const converted = fromPiAssistant(final, target);
      const result: NativeRuntimeResult = {
        content: converted.content,
        stopReason: mapPiStopReason(final.stopReason, converted.content.some((b) => b.type === "tool_use")),
        usage,
        durationMs: Date.now() - start,
        ...(converted.providerRaw ? { providerRaw: converted.providerRaw } : {}),
      };
      return result;
    } catch (error) {
      if (call.operatorAborted()) return this.cancelledResult(start, label);
      if (state.failover && !signal?.aborted) return "failover";
      if (state.failure) return this.failureResult(start, label, state.failure, redact, timeout.signal.aborted);
      const message = redact(error instanceof Error ? error.message : String(error));
      return this.errorResult(start, label, message, timeout.signal.aborted);
    } finally {
      clearTimeout(timer);
      call.dispose();
    }
  }

  /** Typed policy failures keep the default runtime's exact error text conventions. */
  private failureResult(start: number, label: string, failure: Error, redact: (t: string) => string, timedOut: boolean): NativeRuntimeResult {
    const message = redact(failure.message);
    // Quota and local-admission errors are reported verbatim (callers key on their prefixes); the rest as API errors.
    if (failure instanceof QuotaExhaustedError || isLocalAdmissionFailure(failure.message)) {
      return { content: [{ type: "text", text: "" }], stopReason: "error", durationMs: Date.now() - start, error: message };
    }
    const unknownOutcome = /automatic replay (?:is )?disabled|outcome.{0,30}unknown/i.test(message);
    return {
      content: [{ type: "text", text: "" }], stopReason: "error", durationMs: Date.now() - start,
      ...(timedOut ? { timedOut: true } : {}),
      error: timedOut ? `${label} API request timed out${unknownOutcome ? "; request outcome may be unknown. Automatic replay is disabled" : ""}` : `${label} API error: ${message}`,
    };
  }

  private errorResult(start: number, label: string, message: string, timedOut: boolean, usage?: NativeRuntimeResult["usage"]): NativeRuntimeResult {
    return {
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      durationMs: Date.now() - start,
      ...(usage ? { usage } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      error: timedOut ? `${label} API request timed out` : `${label} API error: ${message}`,
    };
  }

  // ── legacy single-shot Runtime ────────────────────────────────────────

  async execute(prompt: string, context?: RuntimeContext): Promise<RuntimeResult> {
    const start = Date.now();
    const result = await this.executeNative(
      context?.systemPrompt ?? "",
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      [],
      undefined,
      context?.signal,
    );
    const output = result.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const failed = result.stopReason === "error";
    return {
      output,
      exitCode: failed ? 1 : 0,
      timedOut: result.timedOut === true,
      durationMs: Date.now() - start,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(failed && result.error ? { error: result.error } : {}),
    };
  }
}

async function isRetryable(message: AssistantMessage): Promise<boolean> {
  const { isRetryableAssistantError } = await import("@earendil-works/pi-ai");
  return isRetryableAssistantError(message);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
