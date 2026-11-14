import { isOpenCodeGoEndpoint, publishedOpenCodeGoContext } from "../opencode-go.js";
import { captureSiwcConnection, listSiwcModels, siwcHeaders, type SiwcConnection } from "../siwc-connection.js";
import { type Runtime, type NativeRuntime, type NativeStreamCallbacks, type RuntimeConfig, type AccessProgramMetadata, type SubagentModelSelection, type RuntimeContext, type RuntimeResult, type NativeMessage, type NativeToolDef, type NativeRuntimeResult, type NativeContentBlock } from "../types.js";
import { assertRequestAdmission, isLocalAdmissionFailure, LOCAL_ADMISSION_UNAVAILABLE, parseRequestAdmission, type RequestAdmission } from "../request-admission.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { VERSION } from "../../shared/index.js";
import { features } from "../../agent/features.js";
import { diag } from "../../diagnostics/channel.js";
import { MESSAGE_CACHE_BREAKPOINTS, planMessageBreakpoints, providerSupportsPromptCache, readCacheUsage, withCacheControl, type WireBlock } from "../prompt-cache.js";
import { type CodexCatalogModel } from "../codex-models.js";
import { resolveWorkbenchProviderProxy } from "../workbench-provider-proxy.js";
import { NATIVE_COMPLETION_TOKEN_LIMIT, isWireBlockArray, parseResponsesFunctionCall, readChatUsage, readGoogleUsage, readResponsesCachedTokens, readResponsesUsage, safeParseJson } from "./usage-parsing.js";
import { appendNativeTrace, logProviderStartup } from "./startup-log.js";
import { OperatorAbortError, QuotaExhaustedError, classifyTransportFailure, composeCallAbort, delayWithAbort, isPolicyRefusalResult, isRetryableHttpStatus, llm429MaxRetries, llm429MaxRetryWaitMs, llmMaxRetries, llmMaxRetryWaitMs, llmStreamEventIdleTimeoutMs, llmStreamIdleTimeoutMs, llmStreamMaxAttempts, mergeRuntimeUsage, parseRetryAfterMs, parseUsageLimitReached, retryAfterMsFromHeaders, retryBackoffMs, shouldRetryNativeStream, sleepWithAbort, streamRetryBackoffMs, type CallAbort, unknownTransportOutcome } from "./retry.js";
import { CODEX_API_ENDPOINT, CODEX_PROTOCOL_HEADERS, CODE_ASSIST_API_VERSION, CODE_ASSIST_ENDPOINT, COPILOT_STATIC_HEADERS, FREE_OPENROUTER_MODEL, PROCESS_SESSION_ID, clineChatResponse, defaultReasoningEffort, normalizeModelForProvider, openAICompatibleWireApi, opencodeWireApiForModel, type ApiProvider, type WireApi, zaiThinkingBudget } from "./provider-config.js";
import { getFallbackChain, resolveFailoverProvider, type ApiProviderConnection, type FallbackEntry } from "./fallback.js";
import { readChatGptCodexAuthFile, readChatGptCodexEnv, refreshChatGptCodexAuthState, resolveChatGptCodexAuthState, type ChatGptCodexAuthState } from "./codex-auth.js";
import { firstNonEmptyEnv, geminiUserAgent, readGeminiCodeAssistEnv, refreshGeminiCodeAssistAuthState, resolveGeminiCodeAssistAuthState, resolveGeminiCodeAssistProject, type GeminiCodeAssistAuthState } from "./gemini-auth.js";
import { parseCodexAzureConfig } from "./provider-config.js";
import { AUTO_MODEL_SENTINEL, DEFAULT_PROVIDER_MODELS, detectProvider, providerForModel, type ApiRuntimeDiagnostics } from "./provider-detect.js";

let googleFunctionCallSequence = 0;

/**
 * Runtime that calls LLM APIs directly.
 *
 * Supports multiple providers with automatic detection:
 * - ChatGPT Codex (ZERO_CHATGPT_OAUTH_REFRESH_TOKEN) — subscription-backed Codex access
 * - OpenRouter (OPENROUTER_API_KEY) — access many models through one API
 * - Anthropic (ANTHROPIC_API_KEY) — direct Claude API access
 * - OpenAI (OPENAI_API_KEY) — direct OpenAI API access
 *
 * Model can be overridden with ZERO_MODEL env var or --model flag.
 *
 * Supports two modes:
 * - Legacy: single-prompt execute() for backward compat with existing agent loop
 * - Native: structured multi-turn messages with tool_use for the new agent loop
 */
/** Secret-bearing host IPC state. Never expose through public snapshots or logs. */
export interface PrivateWorkerRuntimeBinding {
  config: RuntimeConfig;
  env: Record<string, string>;
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  wireApi: WireApi;
  reasoningEffort?: string;
  azureConfig: ReturnType<typeof parseCodexAzureConfig>;
  serverCompactionTokens?: number;
  codexAuthState?: Omit<ChatGptCodexAuthState, "inflightRefresh">;
  geminiAuthState?: Omit<GeminiCodeAssistAuthState, "inflightRefresh" | "inflightProjectResolve">;
  fallbackChain: Array<FallbackEntry & { credentials?: ApiProviderConnection }>;
  fallbackIndex: number;
  identity: string;
  opencodeConversationId: string;
  accessProgramReceipt?: AccessProgramMetadata;
}

export class LlmApiRuntime implements Runtime, NativeRuntime {
  readonly type = "api" as const;
  // These are set by the constructor via applyConfiguration() (root) or the
  // inherited fork branch; the `!` records that a fork sets them directly while
  // the root path assigns them through the shared applyConfiguration() helper.
  // One runtime is one conversation. Forked agents have independent transcripts
  // and get their own opaque routing bucket rather than sharing a parent cache.
  private readonly opencodeConversationId = `ses_${randomUUID()}`;

  private config!: RuntimeConfig;
  // Not readonly: a live provider switch re-freezes env from the new account.
  private env!: Readonly<NodeJS.ProcessEnv>;
  private requestAdmission?: Promise<RequestAdmission>;
  private requestAdmissionIdentity?: string;
  private codexAuthState?: ChatGptCodexAuthState;
  private grantedProviderTransport?: RuntimeConfig["providerTransport"];
  private workbenchProviderProxy?: { url: string; model: string };
  private geminiAuthState?: GeminiCodeAssistAuthState;
  private siwcConnection?: SiwcConnection;
  private siwcModels?: Promise<ReadonlySet<string>>;
  private provider!: ApiProvider;
  private apiKey!: string;
  private baseUrl!: string;
  private model!: string;
  private pricingModelSource = "";
  private pricingProviderSource?: ApiProvider;
  private pricingModelKey = "";
  private wireApi!: WireApi;
  private reasoningEffort?: string;
  private azureConfig!: ReturnType<typeof parseCodexAzureConfig>;
  private serverCompactionTokens?: number;
  /** Ordered fallback chain (ZERO_LLM_FALLBACK). Empty = no failover. */
  private fallbackChain!: Array<FallbackEntry & { credentials?: ApiProviderConnection }>;
  /** Index into fallbackChain — which entry to try next. */
  private fallbackIndex!: number;

  constructor(config: RuntimeConfig, inherited?: LlmApiRuntime) {
    if (config.cyberAccessProgram !== undefined && ((config.provider !== "openai" && config.provider !== "chatgpt-codex") || config.providerTransport || config.siwcConnection || (config.provider === "chatgpt-codex" && config.apiKey !== undefined))) throw new Error("Cyber access program requires explicit OpenAI API or ChatGPT Codex OAuth provider and its supported Responses endpoint.");
    // Fork construction must never rediscover an account or endpoint.
    // The inherited runtime is host-internal; no credential snapshot is exported.
    if (inherited) {
      const timeout = config.timeout ?? inherited.config.timeout ?? 120_000;
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error("Subagent timeout must be a positive finite number");
      }
      const requestedModel = config.model ?? inherited.model;
      const modelChanged = requestedModel !== inherited.model;
      // A child model may pin a different provider than the parent's resolved
      // route (e.g. an `openrouter/<vendor>/<model>` role pin under an OpenAI
      // or Codex parent). The fork guard approves such pins through
      // `providerForModel`, so the child must dispatch with the model's
      // natural provider — resolved strictly from credentials already
      // snapshotted in the inherited environment (the same auth-presence check
      // the failover chain uses; model selection never grants a child new
      // account authority). Without this, the prefixed routing id goes
      // verbatim to the parent's endpoint and the upstream rejects it
      // ("not a valid model ID").
      let provider = inherited.provider;
      let apiKey = inherited.apiKey;
      let baseUrl = inherited.baseUrl;
      let wireApi = inherited.wireApi;
      let workbenchProviderProxy = inherited.workbenchProviderProxy;
      if (modelChanged) {
        const m = requestedModel.toLowerCase();
        const routedProvider =
          m.startsWith("opencode/") ? "opencode" as const :
          m.startsWith("copilot/") ? "copilot" as const :
          m.startsWith("cline/") ? "cline" as const :
          m.startsWith("openrouter/") ? "openrouter" as const : undefined;
        if (routedProvider && routedProvider !== inherited.provider) {
          const connection = resolveFailoverProvider(routedProvider, requestedModel, inherited.env);
          if (connection) {
            provider = routedProvider;
            apiKey = connection.apiKey;
            baseUrl = connection.baseUrl;
            wireApi = connection.wireApi;
            // The workbench proxy is bound to the parent's provider+model; a
            // rerouted child dispatches directly under its own route.
            workbenchProviderProxy = undefined;
          }
        }
      }
      // Inherited IDs are already native provider IDs, not routing selections.
      const model = modelChanged ? normalizeModelForProvider(provider, requestedModel) : inherited.model;
      this.config = {
        type: "api",
        model,
        provider: inherited.config.provider,
        cyberAccessProgram: inherited.config.cyberAccessProgram,
        onAccessProgram: inherited.config.onAccessProgram,
        siwcConnection: inherited.siwcConnection,
        agentModels: inherited.config.agentModels,
        singleModel: inherited.config.singleModel,
        timeout: Math.min(timeout, inherited.config.timeout || 120_000),
      };
      this.env = inherited.env;
      this.workbenchProviderProxy = workbenchProviderProxy;
      this.grantedProviderTransport = inherited.grantedProviderTransport;
      this.siwcConnection = inherited.siwcConnection;
      this.siwcModels = inherited.siwcModels;
      this.provider = provider;
      this.apiKey = apiKey;
      this.baseUrl = baseUrl;
      this.model = model;
      this.wireApi = wireApi;
      if (modelChanged) {
        if (this.provider === "opencode") this.wireApi = opencodeWireApiForModel(model);
        if (this.provider === "openai") this.wireApi = openAICompatibleWireApi(this.env, "OPENAI_WIRE_API");
        if (this.provider === "azure") this.wireApi = openAICompatibleWireApi(this.env, "AZURE_OPENAI_WIRE_API", inherited.azureConfig.wireApi);
        this.applyModelWireApi();
      }
      this.reasoningEffort = modelChanged ? undefined : inherited.reasoningEffort;
      this.azureConfig = { ...inherited.azureConfig };
      this.serverCompactionTokens = inherited.serverCompactionTokens;
      if (inherited.codexAuthState) this.codexAuthState = inherited.codexAuthState;
      if (inherited.geminiAuthState) this.geminiAuthState = inherited.geminiAuthState;
      // Model selection never grants a child cross-account fallback authority.
      this.fallbackChain = [];
      this.fallbackIndex = 0;
      this.assertAccessProgramRoute();
      return;
    }
    this.applyConfiguration(config);
    this.assertAccessProgramRoute();
  }

  /**
   * Root provider/model detection. Shared by the constructor and
   * {@link reconfigure} so a live provider switch re-resolves the account,
   * endpoint, wire protocol and default model with the SAME logic the
   * constructor uses — never a second, drifting code path.
   */
  private applyConfiguration(config: RuntimeConfig): void {
    this.config = {
      ...config,
      ...(config.agentModels ? { agentModels: Object.freeze({ ...config.agentModels }) } : {}),
    };
    this.siwcConnection = undefined;
    this.siwcModels = undefined;
    if (config.provider === "chatgpt-plan") {
      if (!config.siwcConnection || !config.model) throw new Error("ChatGPT plan requires a verified connection and a model selected from its catalog");
      if (config.providerTransport || config.apiKey) throw new Error("ChatGPT plan cannot use API keys or Codex transport");
      this.siwcConnection = captureSiwcConnection(config.siwcConnection);
      this.config = { ...this.config, siwcConnection: this.siwcConnection };
      this.env = Object.freeze({ ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" });
      this.grantedProviderTransport = undefined; this.workbenchProviderProxy = undefined;
      this.azureConfig = parseCodexAzureConfig({}); this.fallbackChain = []; this.fallbackIndex = 0;
      this.provider = "chatgpt-plan"; this.apiKey = ""; this.baseUrl = "https://api.openai.com/v1";
      this.wireApi = "responses"; this.model = config.model; this.codexAuthState = undefined;
      this.geminiAuthState = undefined; this.reasoningEffort = config.env?.["ZERO_REASONING_EFFORT"]; this.serverCompactionTokens = undefined;
      return;
    }
    this.grantedProviderTransport = config.providerTransport;
    if (config.providerTransport) {
      const grant = config.providerTransport;
      if (grant.provider !== "chatgpt-codex" || (config.provider && config.provider !== grant.provider) || !config.model || !grant.models.includes(config.model)) throw new Error("Model is outside the explicit provider transport grant");
      for (const model of Object.values(config.agentModels ?? {})) if (model !== "auto" && !grant.models.includes(model)) throw new Error("Worker model is outside the explicit provider transport grant");
      this.env = Object.freeze({ ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" });
      this.workbenchProviderProxy = undefined; this.azureConfig = parseCodexAzureConfig({});
      this.fallbackChain = []; this.fallbackIndex = 0; this.provider = grant.provider; this.apiKey = "";
      this.baseUrl = "https://provider-relay.invalid"; this.wireApi = "responses"; this.model = config.model;
      this.codexAuthState = undefined; this.geminiAuthState = undefined; this.reasoningEffort = undefined;
      this.serverCompactionTokens = config.serverCompactionTokens === undefined ? undefined : Math.max(1000, config.serverCompactionTokens); return;
    }
    this.env = Object.freeze({ ...process.env, ...config.env });
    this.requestAdmission = undefined;
    this.requestAdmissionIdentity = undefined;
    this.workbenchProviderProxy = resolveWorkbenchProviderProxy(this.env);
    this.azureConfig = parseCodexAzureConfig(this.env);
    this.fallbackChain = (this.workbenchProviderProxy ? [] : getFallbackChain(this.env)).map(entry => ({
      ...entry, credentials: resolveFailoverProvider(entry.provider, entry.model, this.env),
    }));
    this.fallbackIndex = 0;
    // Thread the requested model into detection so provider follows the model
    // per-call (per-call multi-provider routing) when its auth is available.
    const detected = detectProvider(config.apiKey, config.model ?? this.env["ZERO_MODEL"], this.env, config.provider);
    this.provider = detected.provider;
    this.apiKey = detected.apiKey;
    this.baseUrl = detected.baseUrl;
    this.wireApi = detected.wireApi;
    // Clear any prior codex auth so a switch away from ChatGPT Codex cannot
    // carry a stale OAuth state; re-resolve only when the new route needs it.
    this.codexAuthState = undefined;
    if (!this.workbenchProviderProxy && (this.provider === "chatgpt-codex" || this.fallbackChain.some(entry => entry.provider === "chatgpt-codex"))) {
      if (readChatGptCodexEnv(this.env) || readChatGptCodexAuthFile(this.env)) {
        this.codexAuthState = resolveChatGptCodexAuthState(this.env);
      }
    }
    // Same shape for Google Code Assist: capture the OAuth state for the primary
    // provider or any fallback entry that routes to it.
    this.geminiAuthState = undefined;
    if (this.provider === "google" || this.fallbackChain.some(entry => entry.provider === "google")) {
      if (readGeminiCodeAssistEnv(this.env)) {
        this.geminiAuthState = resolveGeminiCodeAssistAuthState(this.env);
      }
    }
    this.reasoningEffort = this.env["ZERO_REASONING_EFFORT"] ?? detected.reasoningEffort;
    // `compact_threshold` has an API minimum of 1000; clamp rather than send a
    // value the server will reject on the hot path of every request.
    this.serverCompactionTokens = config.serverCompactionTokens !== undefined
      ? Math.max(1000, config.serverCompactionTokens)
      : undefined;
    const requestedModel = config.model ?? this.env["ZERO_MODEL"];
    // "free" is a special alias for the free OpenRouter model
    if (requestedModel === "free" && this.provider === "openrouter") {
      this.model = FREE_OPENROUTER_MODEL;
    } else {
      this.model = requestedModel ?? detected.defaultModel;
    }
    // Strip each provider's own routing prefix (`opencode/<id>`,
    // `copilot/<id>`, `cline/<id>`, `openrouter/<vendor>/<model>`) once the
    // provider is selected so the endpoint receives the canonical catalog id;
    // sending a prefixed id verbatim 400s with "not a valid model ID".
    // cline-pass/ is part of the upstream id and is preserved.
    this.model = normalizeModelForProvider(this.provider, this.model);

    // These deployments reject function tools plus reasoning_effort on
    // /chat/completions. The Responses endpoint supports the agent loop, so
    // upgrade only the exact provider/model pairs rather than changing every
    // OpenAI-compatible deployment's requested wire API.
    this.applyModelWireApi();

    // Fire-and-forget startup banner. For Azure, this probes `/models`
    // once for the x-ms-region header so operators can see where their
    // traffic physically lands (data-residency transparency). The probe
    // is cached and tolerant of failures — never blocks the main path.
    // Skip entirely when no key is configured (the diagnostics path will
    // surface the missing-key error to the user instead).
    if (this.apiKey && !this.env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"]) {
      void logProviderStartup(
        this.provider,
        this.providerLabel,
        this.baseUrl,
        this.model,
        this.wireApi,
        this.apiKey,
      ).catch(() => {
        // Swallow — startup logging must never abort runtime init.
      });
    }
  }

  private readonly accessProgramObservation = new AsyncLocalStorage<{ confirmed?: AccessProgramMetadata["confirmed"] }>();
  private get observedAccessProgram(): AccessProgramMetadata["confirmed"] { return this.accessProgramObservation.getStore()?.confirmed; }
  private set observedAccessProgram(value: AccessProgramMetadata["confirmed"]) { const observation = this.accessProgramObservation.getStore(); if (observation) observation.confirmed = value; }

  private assertAccessProgramRoute(): void {
    if (this.config.cyberAccessProgram === undefined) return;
    const publicApi = this.config.provider === "openai" && this.provider === "openai" && /^https:\/\/api\.openai\.com\/v1\/?$/.test(this.baseUrl);
    const subscription = this.config.provider === "chatgpt-codex" && this.provider === "chatgpt-codex" &&
      this.baseUrl === CODEX_API_ENDPOINT && Boolean(this.codexAuthState?.accountId);
    if (!["standard", "daybreak_blue", "daybreak_red"].includes(this.config.cyberAccessProgram) ||
        (!publicApi && !subscription) || this.wireApi !== "responses" ||
        this.siwcConnection || this.grantedProviderTransport || this.workbenchProviderProxy) {
      throw new Error("Cyber access program requires explicit OpenAI provider or captured ChatGPT Codex OAuth account, canonical endpoint and Responses API.");
    }
  }

  private accessProgramSelectionEpoch = 0;
  private lastAccessProgramReceipt?: AccessProgramMetadata;

  private retainAccessProgramReceipt(epoch: number): void {
    if (epoch !== this.accessProgramSelectionEpoch || this.config.cyberAccessProgram === undefined) return;
    const metadata: AccessProgramMetadata = { requested: this.config.cyberAccessProgram, ...(this.observedAccessProgram ? { confirmed: this.observedAccessProgram } : {}) };
    this.lastAccessProgramReceipt = metadata;
    this.config.onAccessProgram?.(metadata);
  }

  /** Idle-boundary selection change; never rediscover a provider or account. */
  setCyberAccessProgram(value: RuntimeConfig["cyberAccessProgram"] | null): void {
    const previous = this.config;
    this.config = { ...previous, ...(value === null ? {} : { provider: this.provider }), cyberAccessProgram: value ?? undefined };
    try { this.assertAccessProgramRoute(); }
    catch (error) { this.config = previous; throw error; }
    this.accessProgramSelectionEpoch++;
    this.lastAccessProgramReceipt = undefined;
  }

  getCyberAccessProgram(): RuntimeConfig["cyberAccessProgram"] { return this.config.cyberAccessProgram; }

  cyberAccessProgramConfiguration(): { confirmed?: NonNullable<RuntimeConfig["cyberAccessProgram"]>; requested?: NonNullable<RuntimeConfig["cyberAccessProgram"]>; options: NonNullable<RuntimeConfig["cyberAccessProgram"]>[]; unavailableReason?: string } {
    const previous = this.config;
    try {
      this.config = { ...previous, provider: this.provider, cyberAccessProgram: previous.cyberAccessProgram ?? "standard" };
      this.assertAccessProgramRoute();
      return { ...(previous.cyberAccessProgram ? { requested: previous.cyberAccessProgram } : {}), ...(this.lastAccessProgramReceipt?.requested === previous.cyberAccessProgram && this.lastAccessProgramReceipt?.confirmed ? { confirmed: this.lastAccessProgramReceipt.confirmed } : {}), options: ["standard", "daybreak_blue", "daybreak_red"] };
    } catch (error) {
      return { options: [], unavailableReason: error instanceof Error ? error.message : "Unsupported runtime route" };
    } finally { this.config = previous; }
  }

  private observeAccessProgram(response: unknown): void {
    const value = (response as { access_programs?: { cyber?: unknown } } | undefined)?.access_programs?.cyber;
    if (value === "standard" || value === "daybreak_blue" || value === "daybreak_red") this.observedAccessProgram = value;
  }

  /**
   * Host-only secret export for a private worker pipe; never a public runtime snapshot.
   * After OAuth rotation, replacement workers need the child's updated binding
   * (or explicit reconnect), never the parent's stale pre-worker token snapshot.
   */
  exportPrivateWorkerBinding(): PrivateWorkerRuntimeBinding {
    if (this.config.onAccessProgram) throw new Error("Access program callback requires in-process execution; cannot serialize to a host worker.");
    if (this.siwcConnection || this.grantedProviderTransport || this.workbenchProviderProxy) {
      throw new Error("This connection requires an in-process transport and cannot be moved to a host worker.");
    }
    if (this.codexAuthState?.inflightRefresh || this.geminiAuthState?.inflightRefresh || this.geminiAuthState?.inflightProjectResolve) {
      throw new Error("Wait for connection refresh to finish before starting the host worker.");
    }
    const identity = this.connectionIdentity();
    if (!identity) throw new Error("The selected runtime has no captured connection identity.");
    // Retain provider/routing settings for approved child models. Host execution
    // variables (PATH, HOME, NODE_OPTIONS, shell hooks) never cross this boundary.
    const env = Object.fromEntries(Object.entries(this.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && /^(?:(?:OPENAI|OPENROUTER|ANTHROPIC|AZURE_OPENAI|DEEPSEEK|Z_AI|KIMI|QWEN|XAI|OPENCODE|CLINE|TOGETHER|COPILOT|GOOGLE)_|ZERO_(?:CHATGPT_|GEMINI_|COPILOT_|LLM_|REASONING_|REGION_OVERRIDE$|ZAI_THINKING_BUDGET$|MODEL$|SELECTED_PROVIDER$|FORCE_PROVIDER$|PROVIDER$|REQUIRE_|SUPPRESS_PROVIDER_STARTUP_LOG$|CODEX_AUTH_JSON_PATH$))/.test(entry[0])));
    const config: RuntimeConfig = { type: "api", timeout: this.config.timeout,
      provider: this.provider, model: this.model, cyberAccessProgram: this.config.cyberAccessProgram, ...this.modelSelection() };
    const { inflightRefresh: _codexRefresh, ...codexAuthState } = this.codexAuthState ?? {};
    const { inflightRefresh: _geminiRefresh, inflightProjectResolve: _projectRefresh, ...geminiAuthState } = this.geminiAuthState ?? {};
    return structuredClone({ config, env, provider: this.provider, apiKey: this.apiKey,
      baseUrl: this.baseUrl, model: this.model, wireApi: this.wireApi,
      reasoningEffort: this.reasoningEffort, azureConfig: this.azureConfig,
      serverCompactionTokens: this.serverCompactionTokens,
      ...(this.codexAuthState ? { codexAuthState: codexAuthState as PrivateWorkerRuntimeBinding["codexAuthState"] } : {}),
      ...(this.geminiAuthState ? { geminiAuthState: geminiAuthState as PrivateWorkerRuntimeBinding["geminiAuthState"] } : {}),
      fallbackChain: this.fallbackChain, fallbackIndex: this.fallbackIndex, identity, opencodeConversationId: this.opencodeConversationId,
      ...(this.lastAccessProgramReceipt ? { accessProgramReceipt: this.lastAccessProgramReceipt } : {}) });
  }

  /** Rehydrate a trusted private-pipe binding without auth discovery or ambient defaults. */
  static fromPrivateWorkerBinding(binding: PrivateWorkerRuntimeBinding): LlmApiRuntime {
    const sealed = structuredClone(binding);
    if (!/^ses_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sealed.opencodeConversationId) || !sealed.identity || sealed.config.type !== "api" || sealed.config.model !== sealed.model || sealed.config.provider !== sealed.provider || !Number.isFinite(sealed.config.timeout) || sealed.config.timeout <= 0) {
      throw new Error("Invalid host worker runtime binding.");
    }
    // The inherited constructor copies an existing connection; unlike root
    // construction it never reads auth files, current environment or defaults.
    const donor = Object.assign(Object.create(LlmApiRuntime.prototype) as LlmApiRuntime, sealed);
    const runtime = new LlmApiRuntime(sealed.config, donor);
    Object.defineProperty(runtime, "opencodeConversationId", { value: sealed.opencodeConversationId });
    runtime.config = { ...sealed.config, agentModels: Object.freeze({ ...sealed.config.agentModels }) };
    runtime.env = Object.freeze({ ...sealed.env });
    runtime.fallbackChain = sealed.fallbackChain;
    runtime.fallbackIndex = sealed.fallbackIndex;
    runtime.assertAccessProgramRoute();
    if (sealed.accessProgramReceipt) {
      const receipt = sealed.accessProgramReceipt;
      if (receipt.requested !== runtime.config.cyberAccessProgram || (receipt.confirmed !== undefined && !["standard", "daybreak_blue", "daybreak_red"].includes(receipt.confirmed))) throw new Error("Invalid worker access program receipt.");
      runtime.lastAccessProgramReceipt = receipt;
    }
    if (runtime.connectionIdentity() !== sealed.identity) throw new Error("Host worker connection identity does not match the captured session.");
    return runtime;
  }

  /** Apply a private worker checkpoint only to the same live account/selection.
   * The host must additionally verify its session/worker epoch before calling. */
  applyPrivateWorkerBinding(binding: PrivateWorkerRuntimeBinding, options?: { replaceSelection: true }): void {
    const candidate = LlmApiRuntime.fromPrivateWorkerBinding(binding);
    if (!options?.replaceSelection && (candidate.connectionIdentity() !== this.connectionIdentity() || candidate.provider !== this.provider || candidate.model !== this.model || candidate.config.cyberAccessProgram !== this.config.cyberAccessProgram || candidate.opencodeConversationId !== this.opencodeConversationId)) {
      throw new Error("Worker checkpoint does not match the current session connection and model.");
    }
    if (this.siwcConnection || this.grantedProviderTransport || this.workbenchProviderProxy) throw new Error("This connection cannot accept a host worker checkpoint.");
    if (options?.replaceSelection) {
      Object.defineProperty(this, "opencodeConversationId", { value: candidate.opencodeConversationId });
      this.config = candidate.config;
      this.provider = candidate.provider;
      this.model = candidate.model;
      this.reasoningEffort = candidate.reasoningEffort;
      this.serverCompactionTokens = candidate.serverCompactionTokens;
      this.accessProgramSelectionEpoch++;
      this.requestAdmission = undefined;
      this.requestAdmissionIdentity = undefined;
    }
    this.lastAccessProgramReceipt = candidate.lastAccessProgramReceipt;
    this.env = candidate.env;
    this.apiKey = candidate.apiKey;
    this.baseUrl = candidate.baseUrl;
    this.wireApi = candidate.wireApi;
    this.codexAuthState = candidate.codexAuthState;
    this.geminiAuthState = candidate.geminiAuthState;
    this.azureConfig = candidate.azureConfig;
    this.fallbackChain = candidate.fallbackChain;
    this.fallbackIndex = candidate.fallbackIndex;
  }

  /** Non-secret identity for preferences scoped to the captured connection. */
  connectionIdentity(): string | undefined {
    if (this.siwcConnection) return createHash("sha256").update(JSON.stringify(["chatgpt-plan", this.siwcConnection.accountId, this.siwcConnection.clientId, this.siwcConnection.hostId])).digest("hex");
    if (this.grantedProviderTransport) return this.grantedProviderTransport.identity;
    let identity: readonly string[];
    if (this.provider === "chatgpt-codex") {
      const state = this.codexAuthState;
      if (!state) return undefined;
      if (state.accountId) {
        identity = [this.provider, "account", state.accountId];
      } else {
        const credential = state.refreshToken || state.accessToken;
        if (!credential) return undefined;
        identity = [this.provider, "credential", credential];
      }
    } else if (this.provider === "google") {
      const credential = this.geminiAuthState?.refreshToken || this.geminiAuthState?.accessToken;
      if (!credential) return undefined;
      identity = [this.provider, this.baseUrl, credential, firstNonEmptyEnv(this.env, "GOOGLE_CLOUD_PROJECT", "ZERO_GEMINI_PROJECT") ?? "", this.geminiAuthState?.oauthClient?.clientId ?? "legacy"];
    } else {
      if (!this.apiKey) return undefined;
      identity = [this.provider, this.baseUrl, this.apiKey];
    }
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }

  /** Documented effort controls only on routes which send Responses reasoning. */
  reasoningConfiguration(): { effort: string; options: string[] } | null {
    if (this.wireApi !== "responses" || !["openai", "azure", "chatgpt-codex", "chatgpt-plan"].includes(this.provider)) return null;
    // https://developers.openai.com/api/docs/guides/latest-model
    const model = this.model.replace(/^openai\//, "");
    let options: string[];
    if (/^gpt-(?:6-astra|6\.1-sol)(?:-20\d\d-\d\d-\d\d)?$/.test(model)) options = ["low", "medium", "high", "xhigh", "max"];
    else if (/^gpt-(?:6-sol|6-luna|5\.6(?:-sol|-terra|-luna)?)(?:-20\d\d-\d\d-\d\d)?$/.test(model)) options = ["none", "low", "medium", "high", "xhigh", "max"];
    else return null;
    const effort = this.reasoningEffort ?? defaultReasoningEffort(this.model) ?? "medium";
    // Do not disguise an existing unsupported custom configuration as a choice.
    return options.includes(effort) ? { effort, options } : null;
  }

  /** Apply an effort for subsequent requests and same-model worker forks. */
  setReasoningEffort(effort: string): void {
    const configuration = this.reasoningConfiguration();
    if (!configuration || !configuration.options.includes(effort)) throw new Error("This reasoning effort is not supported by the selected model and connection.");
    this.reasoningEffort = effort;
  }

  /** Discover models using this runtime's captured account, including after a separate login changes. */
  async codexModelCatalog(signal?: AbortSignal): Promise<CodexCatalogModel[]> {
    if (this.workbenchProviderProxy) {
      signal?.throwIfAborted();
      return [{ id: this.workbenchProviderProxy.model }];
    }
    const state = this.codexAuthState;
    if (this.provider !== "chatgpt-codex" || !state) throw new Error("No active Codex subscription");
    const { loadCodexModelCatalog } = await import("../codex-models.js");
    return loadCodexModelCatalog({ signal, resolveCredentials: () => refreshChatGptCodexAuthState(state) });
  }

  /** Discover endpoint inventory; Cline explicitly marks its public catalog provenance. */
  async availableModelCatalog(signal?: AbortSignal): Promise<Array<{ id: string; contextTokens?: number; source?: "catalog" }>> {
    if (this.provider === "chatgpt-plan") {
      if (!this.siwcConnection) throw new Error("ChatGPT plan connection is unavailable");
      return (await listSiwcModels(this.siwcConnection, fetch, signal)).map(model => ({ id: model.slug, source: "catalog" as const }));
    }
    if (this.provider === "chatgpt-codex") return this.codexModelCatalog(signal);
    const { discoverProviderModels } = await import("../provider-model-discovery.js");
    // Discovery uses the same resolved endpoint and credential snapshot as inference.
    return discoverProviderModels({ provider: this.provider, baseUrl: this.baseUrl,
      headers: this.provider === "google" ? {} : await this.ensureFreshHeaders(), signal,
      ...(this.provider === "together" && this.env["TOGETHER_MODEL_LIST"]?.trim().toLowerCase() === "all" ? { listAll: true } : {}) });
  }

  /** Host-only inference grant bound to this captured account, including after
   * later logins or runtime reconfiguration. Never serialize the closure or
   * its result into guest admission, workspace files or environment. */
  workbenchCredentialResolver(): () => Promise<{ accessToken: string; accountId?: string }> {
    const state = this.codexAuthState;
    if (this.workbenchProviderProxy || this.provider !== "chatgpt-codex" || !state) {
      throw new Error("Host workbench credential broker requires a captured chatgpt-codex account");
    }
    return () => refreshChatGptCodexAuthState(state);
  }


  /**
   * Mutate the live selection in place so the NEXT turn (the engine reads
   * `config.runtime` per turn) and the NEXT `forkForSubagent` pick up the new
   * model / provider / role map with zero session teardown. Undefined fields
   * preserve the current state, except a provider change resets an omitted model.
   */
  useGrantedProviderTransport(transport: NonNullable<RuntimeConfig["providerTransport"]>, selection: { model?: string; agentModels?: Record<string, string>; singleModel?: boolean; autoRoute?: boolean } = {}): void {
    this.applyConfiguration({ ...this.config, apiKey: undefined, env: {}, providerTransport: transport, provider: transport.provider, model: selection.model ?? this.model, ...selection });
  }

  reconfigure(sel: {
    cyberAccessProgram?: RuntimeConfig["cyberAccessProgram"] | null;
    siwcConnection?: SiwcConnection;
    model?: string;
    provider?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
    autoRoute?: boolean;
    env?: NodeJS.ProcessEnv;
  }): void {
    const snapshot = Object.getOwnPropertyDescriptors(this);
    try {
      if (sel.cyberAccessProgram !== undefined) this.config = { ...this.config, cyberAccessProgram: sel.cyberAccessProgram ?? undefined };
      this.reconfigureSelection(sel);
      this.assertAccessProgramRoute();
      this.accessProgramSelectionEpoch++;
      this.lastAccessProgramReceipt = undefined;
    } catch (error) {
      for (const key of Object.keys(this)) if (!(key in snapshot)) delete (this as unknown as Record<string, unknown>)[key];
      Object.defineProperties(this, snapshot);
      throw error;
    }
  }

  private reconfigureSelection(sel: {
    cyberAccessProgram?: RuntimeConfig["cyberAccessProgram"] | null;
    siwcConnection?: SiwcConnection;
    model?: string;
    provider?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
    autoRoute?: boolean;
    env?: NodeJS.ProcessEnv;
  }): void {
    if (this.grantedProviderTransport && ((sel.provider && sel.provider !== this.grantedProviderTransport.provider) || (sel.model && !this.grantedProviderTransport.models.includes(sel.model)) || Object.values(sel.agentModels ?? {}).some(model => model !== "auto" && !this.grantedProviderTransport!.models.includes(model)))) throw new Error("Selection is outside the explicit provider transport grant");
    if (this.siwcConnection && sel.siwcConnection &&
        (sel.siwcConnection.accountId !== this.siwcConnection.accountId || sel.siwcConnection.clientId !== this.siwcConnection.clientId || sel.siwcConnection.hostId !== this.siwcConnection.hostId)) {
      throw new Error("Changing the ChatGPT plan account requires a new chat runtime");
    }
    const providerChanged = sel.provider !== undefined && sel.provider !== this.provider;

    if (providerChanged) {
      // Full re-detection against the (optionally new) account, reusing the
      // exact constructor path. Preserve the role-selection knobs, but never
      // carry the previous provider's model or explicit apiKey to a new connection.
      // Credentials come from the (possibly refreshed) environment.
      const merged: RuntimeConfig = {
        ...this.config,
        apiKey: undefined,
        siwcConnection: sel.provider === "chatgpt-plan" ? sel.siwcConnection : undefined,
        provider: (sel.provider ?? this.provider) as RuntimeConfig["provider"],
        model: sel.model,
        ...(sel.agentModels !== undefined ? { agentModels: sel.agentModels } : {}),
        ...(sel.singleModel !== undefined ? { singleModel: sel.singleModel } : {}),
        ...(sel.autoRoute !== undefined ? { autoRoute: sel.autoRoute } : {}),
        ...(sel.env !== undefined ? { env: sel.env as Record<string, string> } : {}),
      };
      this.applyConfiguration(merged);
      return;
    }

    // No provider change beyond here.
    // agentModels / singleModel affect only future forkForSubagent — no
    // provider work. Re-freeze a replacement map to keep this.config immutable.
    if (sel.agentModels !== undefined) {
      this.config = { ...this.config, agentModels: Object.freeze({ ...sel.agentModels }) };
    }
    if (sel.singleModel !== undefined) {
      this.config = { ...this.config, singleModel: sel.singleModel };
    }
    if (sel.autoRoute !== undefined) {
      this.config = { ...this.config, autoRoute: sel.autoRoute };
    }

    // Same-provider model change: re-run model/wire-api resolution exactly like
    // the fork `modelChanged` branch.
    if (sel.model !== undefined) {
      const model = normalizeModelForProvider(this.provider, sel.model);
      if (model !== this.model) {
        this.model = model;
        this.config = { ...this.config, model };
        if (this.provider === "opencode") this.wireApi = opencodeWireApiForModel(model);
        if (this.provider === "openai") this.wireApi = openAICompatibleWireApi(this.env, "OPENAI_WIRE_API");
        if (this.provider === "azure") this.wireApi = openAICompatibleWireApi(this.env, "AZURE_OPENAI_WIRE_API", this.azureConfig.wireApi);
        this.applyModelWireApi();
        this.reasoningEffort = undefined;
      }
    }
  }

  /** Explicit idle-boundary reconnect; ordinary model picks retain captured credentials. */
  refreshConnection(env: NodeJS.ProcessEnv): void {
    const effort = this.reasoningEffort;
    this.applyConfiguration({ ...this.config, apiKey: undefined,
      provider: this.provider as RuntimeConfig["provider"], model: this.model,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
    this.reasoningEffort = effort;
  }

  /** Modern OpenAI tool calls use Responses, shared by roots and forks. */
  private applyModelWireApi(): void {
    const normalizedModel = this.model.toLowerCase();
    if (this.wireApi === "chat_completions" &&
      ((this.provider === "azure" && normalizedModel === "gpt-5.6-sol") ||
       (this.provider === "openai" &&
         (normalizedModel === "gpt-5.6-luna" || /^gpt-(?:[6-9]|\d{2,})(?:[-.]|$)/.test(normalizedModel))))) {
      this.wireApi = "responses";
    }
  }

  /** Isolated child inference, bound to this runtime's resolved account and route. */
  /**
   * Providers whose credentials are present in THIS runtime's environment
   * (`this.env`, never process-global). A provider counts as accessible iff
   * `resolveFailoverProvider` — the same auth-presence check the cross-provider
   * failover chain uses — including auth-only providers (chatgpt-codex OAuth).
   */
  accessibleProviders(): ApiProvider[] {
    if (this.siwcConnection) return ["chatgpt-plan"];
    if (this.grantedProviderTransport) return [this.grantedProviderTransport.provider];
    if (this.workbenchProviderProxy) return ["chatgpt-codex"];
    const out: ApiProvider[] = [];
    for (const provider of Object.keys(DEFAULT_PROVIDER_MODELS) as ApiProvider[]) {
      const probeModel = DEFAULT_PROVIDER_MODELS[provider] || "probe";
      if (resolveFailoverProvider(provider, probeModel, this.env)) out.push(provider);
    }
    return out;
  }

  /**
   * A concrete, reachable model id per accessible provider (its catalog default)
   * plus the currently-resolved model. This is the read-only roster the
   * orchestrator can be shown so it names a model under an "auto" role that is
   * actually reachable; the fork guard independently accepts any model whose
   * provider has creds, so this is a helpful starting set, not the whole bound.
   */
  accessibleModels(): string[] {
    if (this.grantedProviderTransport) return [...this.grantedProviderTransport.models];
    if (this.workbenchProviderProxy) return [this.workbenchProviderProxy.model];
    const models = new Set<string>();
    if (this.model) models.add(this.model);
    for (const provider of this.accessibleProviders()) {
      const def = DEFAULT_PROVIDER_MODELS[provider];
      if (def) models.add(def);
    }
    return [...models];
  }

  /**
   * Whether `model` routes to a provider whose credentials are present. Uses the
   * same per-call `providerForModel` routing the runtime uses everywhere (which
   * returns a provider only when its key is present), with the concrete
   * accessible defaults as a fallback for ids the router does not pattern-match.
   */
  private isModelAccessible(model: string): boolean {
    if (this.grantedProviderTransport) return this.grantedProviderTransport.models.includes(model);
    if (this.workbenchProviderProxy) return this.accessibleModels().includes(model);
    if (providerForModel(model, this.env) !== undefined) return true;
    return this.accessibleModels().includes(model);
  }

  async forkForSubagent(timeoutMs: number, selection?: SubagentModelSelection): Promise<LlmApiRuntime> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Subagent timeout must be a positive finite number");
    }
    const roleModel = selection?.role !== undefined && this.config.agentModels &&
      Object.hasOwn(this.config.agentModels, selection.role)
      ? this.config.agentModels[selection.role]
      : undefined;
    // AUTO-ROUTING: a role pinned to the "auto" sentinel — or ANY role left
    // unmapped when RuntimeConfig.autoRoute is on — lets the orchestrator pick
    // the model, bounded to what is reachable. "auto" is a sentinel, never a
    // real model id, so it must not flow into the selected model.
    const autoInEffect = roleModel === AUTO_MODEL_SENTINEL ||
      (this.config.autoRoute === true && roleModel === undefined);
    const configuredModel = roleModel === AUTO_MODEL_SENTINEL ? undefined : roleModel;
    const selectedModel = this.config.singleModel
      ? this.model
      : selection?.model ?? configuredModel ?? this.model;
    if (typeof selectedModel !== "string" || !selectedModel.trim()) {
      throw new Error("Subagent model must be a non-empty model ID");
    }
    const model = selectedModel === this.model ? this.model : normalizeModelForProvider(this.provider, selectedModel);
    // Operator-approved allowlist: the parent's own model, or any FIXED pin in
    // agentModels (the "auto" sentinel is not a real pin, so it is excluded).
    const approvedByAllowlist = model === this.model || Object.values(this.config.agentModels ?? {}).some(
      id => id !== AUTO_MODEL_SENTINEL && normalizeModelForProvider(this.provider, id) === model,
    );
    // Auto WIDENS the guard to also accept any model whose provider has creds;
    // it never lets an unreachable model through. singleModel still forces the
    // parent model above, so it is always approved via the allowlist branch.
    const approved = approvedByAllowlist || (autoInEffect && this.isModelAccessible(selectedModel));
    if (!approved) {
      throw new Error(
        autoInEffect
          ? `Subagent model "${selectedModel}" is not reachable: its provider has no configured credentials.`
          : `Subagent model "${selectedModel}" is not operator-approved. Configure agentModels before selecting it.`,
      );
    }
    // Pass the selection, not its normalized comparison key: the inherited
    // constructor normalizes changed selections once. Unchanged native IDs stay intact.
    const child = new LlmApiRuntime({ type: "api", timeout: timeoutMs, model: selectedModel }, this);
    return child;
  }


  /**
   * A hard dollar ceiling needs a provider-enforced bound on the next response.
   * ChatGPT Codex OAuth rejects `max_output_tokens`, so it cannot support that
   * contract; callers must fail closed before making a metered comparison call.
   */
  get outputTokenLimit(): number | undefined {
    return this.provider === "chatgpt-codex" || this.provider === "chatgpt-plan" ? undefined : NATIVE_COMPLETION_TOKEN_LIMIT;
  }

  /**
   * Whether this provider uses OpenAI-compatible chat/completions format.
   *
   * DO NOT add "z-ai" or "kimi" here. They speak the Anthropic Messages wire
   * (see `isAnthropicWire`); adding them to this getter would silently route
   * them to `/chat/completions` with a Bearer header and break them. Their
   * `wireApi` field is set to "chat_completions" by detectProvider only as an
   * inert default — it is intentionally unused for these two providers.
   */
  private get isOpenAICompat(): boolean {
    return (
      this.provider === "openrouter" ||
      this.provider === "openai" ||
      this.provider === "chatgpt-plan" ||
      this.provider === "azure" ||
      this.provider === "deepseek" ||
      this.provider === "qwen" ||
      this.provider === "xai" ||
      this.provider === "copilot" ||
      this.provider === "cline" ||
      this.provider === "together" ||
      (this.provider === "opencode" &&
        (this.wireApi === "chat_completions" || this.wireApi === "responses")) ||
      // chatgpt-codex always speaks Responses API; treat it as
      // OpenAI-compat for body-shape branching purposes (the Responses
      // wire-API code paths below already key on `wireApi === "responses"`
      // and produce a body codex's backend accepts as-is).
      this.provider === "chatgpt-codex"
    );
  }

  /**
   * Whether this provider speaks the Anthropic Messages wire (`/v1/messages`
   * with `x-api-key` + `anthropic-version`, Anthropic-shaped body + response).
   *
   * z-ai (GLM) and kimi (Moonshot) are Anthropic-compatible endpoints, so they
   * ride this wire alongside real Anthropic. This is the POSITIVE predicate
   * that drives buildUrl / buildHeaders and the Anthropic branches of
   * execute() / executeNative() — replacing the old implicit "everything that
   * isn't isOpenAICompat" else-fallthrough, which was a footgun: adding a
   * provider to isOpenAICompat, or trusting these two's `wireApi` field, would
   * have silently mis-routed them off the Anthropic wire.
   */
  private get isAnthropicWire(): boolean {
    return (
      this.provider === "anthropic" ||
      this.provider === "z-ai" ||
      this.provider === "kimi" ||
      (this.provider === "opencode" && this.wireApi === "anthropic_messages")
    );
  }

  /** Whether this OpenCode Zen model uses the Google generateContent wire. */
  private get isGoogleWire(): boolean {
    return this.provider === "opencode" && this.wireApi === "google_generate_content";
  }

  /**
   * Whether this is the Google Gemini Code Assist backend. It reuses the Google
   * generateContent request/response SHAPE (googleContents + the isGoogleWire
   * parser) but wraps the body in a `{ model, project, request }` envelope,
   * unwraps `{ response }`, authenticates with a refreshed OAuth Bearer, and
   * posts to a fixed Code Assist endpoint — so it is a distinct predicate from
   * `isGoogleWire`, checked BEFORE it wherever the body/parse branches.
   */
  private get isGeminiCodeAssist(): boolean {
    return this.provider === "google";
  }

  /** Published Go metadata only; no discovery, credential refresh, or capacity probe. */
  publishedContextWindowTokens(): number | undefined {
    if (this.provider !== "openai" && this.provider !== "opencode") return undefined;
    try { return publishedOpenCodeGoContext(new URL(this.baseUrl), this.model); }
    catch { return undefined; }
  }

  /**
   * The resolved model id this runtime will actually call — the requested
   * model when one was picked, otherwise the provider's detected default.
   * Surfaced so the pipeline can stamp the engine-resolved model on
   * `scan_completed` (CI review scans are dispatched with no model pick, so
   * this is the only place the concrete id exists).
   */
  resolvedModel(): string {
    return this.model;
  }

  /** JSON-safe routing policy, not the runtime's private environment or configuration. */
  modelSelection(): { agentModels: Record<string, string>; singleModel: boolean; autoRoute: boolean } {
    return {
      agentModels: { ...this.config.agentModels },
      singleModel: this.config.singleModel === true,
      autoRoute: this.config.autoRoute === true,
    };
  }

  resolvedProvider(): string {
    return this.provider;
  }

  /** Price discovered IDs on their actual route without changing the wire model. */
  resolvedPricingModel(): string {
    if (this.provider === "chatgpt-codex" || this.provider === "copilot" || this.provider === "google") return this.model;
    if (this.pricingModelSource !== this.model || this.pricingProviderSource !== this.provider) {
      this.pricingModelSource = this.model;
      this.pricingProviderSource = this.provider;
      this.pricingModelKey = `${this.provider}/${this.model}`;
    }
    return this.pricingModelKey;
  }

  /** Build the appropriate headers for the configured provider. */
  private buildHeaders(): Record<string, string> {
    if (this.provider === "chatgpt-codex") {
      // OAuth bearer set lazily by ensureFreshHeaders() before each
      // request — we keep a sync facade here for caller ergonomics but
      // the actual access_token is injected pre-flight. Setting an
      // empty Authorization here would override the populated one, so
      // intentionally OMIT it — the pre-flight method writes it.
      // Keep our client identity separate from the shared backend protocol version.
      return {
        "Content-Type": "application/json",
        ...CODEX_PROTOCOL_HEADERS,
        "x-codex-routing-hint": `model=${this.model}`,
        "User-Agent": `0/${VERSION}`,
      };
    }
    if (this.isGeminiCodeAssist) {
      // OAuth Bearer set lazily by ensureFreshHeaders() (like chatgpt-codex);
      // the User-Agent gates the Code Assist subscription quota lane.
      return {
        "Content-Type": "application/json",
        "User-Agent": this.geminiAuthState?.oauthClient ? `0/${VERSION} (${process.platform}; ${process.arch}) ${this.model}` : geminiUserAgent(this.model),
      };
    }
    if (this.isGoogleWire) {
      return {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      };
    }
    if (this.provider === "copilot") {
      // GitHub Copilot rides the OpenAI chat_completions wire (Bearer), but the
      // endpoint additionally requires a set of static VS Code Copilot Chat
      // integration headers. Dedicated branch BEFORE the generic OpenAI-compat
      // path so those headers are always attached.
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...COPILOT_STATIC_HEADERS,
      };
    }
    if (this.isOpenAICompat) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.provider === "azure") {
        // Azure OpenAI uses api-key header, not Bearer token
        headers["api-key"] = this.apiKey;
      } else {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }
      if (this.provider === "openrouter" || this.provider === "cline") {
        headers["HTTP-Referer"] = "https://0.security";
        headers["X-Title"] = "0 Security Scanner";
      }
      return headers;
    }
    // Anthropic Messages wire — also serves the z-ai/GLM and kimi/Moonshot
    // providers (see `isAnthropicWire`). Explicit positive check rather than a
    // bare `else` so a provider that is neither OpenAI-compat nor Anthropic
    // wire fails loudly here instead of silently getting Anthropic headers.
    if (this.isAnthropicWire) {
      return {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      };
    }
    throw new Error(`buildHeaders: provider ${this.provider} is not mapped to a wire`);
  }

  /**
   * For the chatgpt-codex provider, decorate the headers with the
   * freshly-refreshed OAuth bearer + `ChatGPT-Account-Id` + a
   * stable `session_id` (opencode codex.ts:614 — used by Codex
   * backend for request correlation + rate-limit attribution +
   * prompt-cache affinity). For every other provider it's a no-op
   * that returns the stock headers unchanged. Caller MUST await
   * this before the fetch — that's where token refresh actually
   * happens.
   *
   * session_id is process-stable (PROCESS_SESSION_ID, randomised
   * once at module load). A @0/cli invocation = one scan = one
   * session, so the process-lifetime constant is the right
   * granularity. If we ever want per-scan ids inside a long-lived
   * controller process, add a setter on the runtime; for now this
   * matches how the CLI is actually invoked.
   */
  private async ensureFreshHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const base = this.buildHeaders();
    // Go is also configured as an OpenAI-compatible custom endpoint. Select
    // protocol headers by the actual destination, never a provider display name.
    // https://opencode.ai/docs/console/harnesses#sessions
    const destination = new URL(this.baseUrl);
    if (isOpenCodeGoEndpoint(destination)) {
      base["x-opencode-session"] = this.opencodeConversationId;
      base["User-Agent"] = `0/${VERSION}`;
    }
    if (this.provider === "chatgpt-plan") {
      if (!this.siwcConnection) throw new Error("ChatGPT plan connection is unavailable");
      return siwcHeaders(this.siwcConnection, signal);
    }
    if (this.provider === "google") {
      if (!this.geminiAuthState) throw new Error("Google Gemini Code Assist auth: no credential captured for this runtime");
      const accessToken = await refreshGeminiCodeAssistAuthState(this.geminiAuthState);
      base["Authorization"] = `Bearer ${accessToken}`;
      return base;
    }
    if (this.provider !== "chatgpt-codex") return base;
    if (!this.codexAuthState) throw new Error("ChatGPT Codex auth: no credential captured for this runtime");
    const { accessToken, accountId } = await refreshChatGptCodexAuthState(this.codexAuthState);
    base["Authorization"] = `Bearer ${accessToken}`;
    if (accountId) base["ChatGPT-Account-Id"] = accountId;
    base["session_id"] = PROCESS_SESSION_ID;
    // SSE accept header — 0's existing code uses fetch with raw
    // body so the AI SDK doesn't set this for us. Codex backend
    // streams via SSE; without an explicit Accept header some
    // intermediate CDN can downgrade to non-streaming + buffer the
    // whole response. Set it everywhere for chatgpt-codex.
    base["Accept"] = "text/event-stream";
    return base;
  }

  /** Build the API endpoint URL. */
  private buildUrl(): string {
    if (this.provider === "chatgpt-codex") {
      // Codex backend is a fixed endpoint — no base URL substitution.
      // The path is always `/backend-api/codex/responses` regardless of
      // the requested model; that's how the upstream Codex CLI talks
      // to it too.
      return CODEX_API_ENDPOINT;
    }
    if (this.isGeminiCodeAssist) {
      // Code Assist puts the model in the BODY, not the path.
      return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:generateContent`;
    }
    if (this.isGoogleWire) {
      return `${this.baseUrl}/models/${this.model}:generateContent`;
    }
    if (this.isOpenAICompat) {
      return `${this.baseUrl}/${this.wireApi === "responses" ? "responses" : "chat/completions"}`;
    }
    // Anthropic Messages wire — also serves z-ai/GLM and kimi/Moonshot (see
    // `isAnthropicWire`). Explicit positive check rather than a bare fallthrough
    // so an unmapped provider fails loudly instead of silently hitting
    // `/v1/messages`.
    if (this.isAnthropicWire) {
      return this.provider === "opencode"
        ? `${this.baseUrl}/messages`
        : `${this.baseUrl}/v1/messages`;
    }
    throw new Error(`buildUrl: provider ${this.provider} is not mapped to a wire`);
  }

  /**
   * Chat-completions param name for the token cap. Newer OpenAI model
   * families (gpt-5/6, o1/o2/o3) reject the legacy `max_tokens` field
   * and require `max_completion_tokens`. Older models still accept the
   * legacy name, so we flip based on model prefix.
   */
  private get maxTokensParamKey(): "max_tokens" | "max_completion_tokens" {
    return /^gpt-[56](?:[-.]|$)|^o[1-3](?:[-_]|$)/i.test(this.model)
      ? "max_completion_tokens"
      : "max_tokens";
  }

  /**
   * Anthropic `thinking` body fragment. Real Anthropic Claude uses adaptive
   * thinking when retained reasoning is enabled. Z.ai GLM-5.3 requires
   * enabled thinking plus reasoning_effort; earlier GLM models use a
   * budget_tokens field. Kimi reasons natively and accepts neither field.
   */
  private anthropicThinkingField(): Record<string, unknown> {
    if (this.provider === "anthropic") {
      return features.retainedReasoning ? { thinking: { type: "adaptive" } } : {};
    }
    if (this.provider !== "z-ai") return {};

    const budget = zaiThinkingBudget();
    if (this.model.startsWith("glm-5.3")) {
      const reasoningEffort =
        this.reasoningEffort ??
        (budget <= 2048 ? "low" : budget <= 4096 ? "high" : "max");
      return {
        thinking: { type: "enabled" },
        reasoning_effort: reasoningEffort,
      };
    }

    if (budget <= 0) return {};
    return { thinking: { type: "enabled", budget_tokens: budget } };
  }

  /** Convert the unified transcript into Gemini generateContent contents. */
  private googleContents(messages: NativeMessage[]): Array<Record<string, unknown>> {
    const toolNames = new Map<string, string>();
    const upstreamCallIds = new Map<string, string>();
    const contents: Array<Record<string, unknown>> = [];

    for (const message of messages) {
      const parts: Array<Record<string, unknown>> = [];
      const rawParts =
        message.role === "assistant" &&
        message.providerRaw?.provider === this.provider &&
        message.providerRaw.model === this.model &&
        message.providerRaw.wireApi === this.wireApi &&
        Array.isArray(message.providerRaw.output)
          ? message.providerRaw.output as Array<Record<string, unknown>>
          : undefined;

      if (rawParts) {
        const toolUses = message.content.filter(
          (block): block is Extract<NativeContentBlock, { type: "tool_use" }> =>
            block.type === "tool_use",
        );
        let toolUseIndex = 0;
        for (const part of rawParts) {
          const call =
            part.functionCall && typeof part.functionCall === "object"
              ? part.functionCall as Record<string, unknown>
              : undefined;
          const toolUse = call ? toolUses[toolUseIndex++] : undefined;
          const name = typeof call?.name === "string" ? call.name : toolUse?.name;
          if (toolUse && name) {
            toolNames.set(toolUse.id, name);
            if (typeof call?.id === "string") upstreamCallIds.set(toolUse.id, call.id);
          }
          parts.push(part);
        }
      } else {
        for (const block of message.content) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "image") {
            parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
          } else if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            upstreamCallIds.set(block.id, block.id);
            parts.push({ functionCall: { id: block.id, name: block.name, args: block.input } });
          } else if (block.type === "tool_result") {
            const name = toolNames.get(block.tool_use_id);
            if (!name) {
              throw new Error(`Google tool result ${block.tool_use_id} has no matching tool call`);
            }
            const upstreamId = upstreamCallIds.get(block.tool_use_id);
            parts.push({
              functionResponse: {
                ...(upstreamId ? { id: upstreamId } : {}),
                name,
                response: {
                  name,
                  content: block.is_error ? `Error: ${block.content}` : block.content,
                },
              },
            });
          }
        }
      }
      if (parts.length > 0) {
        contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
      }
    }
    return contents;
  }

  /**
   * Wrap a standard Gemini generateContent request body in the Code Assist
   * envelope `{ model, project, user_prompt_id, request }`. Resolves (and
   * caches, via a singleflight) the account's project id first; the FREE tier
   * resolves to `""` and the `project` field is then omitted entirely.
   */
  private async wrapGeminiCodeAssistBody(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.geminiAuthState) throw new Error("Google Gemini Code Assist auth: no credential captured for this runtime");
    const project = await resolveGeminiCodeAssistProject(this.geminiAuthState, this.env);
    return {
      model: this.model,
      ...(project ? { project } : {}),
      user_prompt_id: randomUUID(),
      request,
    };
  }

  /**
   * Per-turn prompt-cache accounting line, so a run can be shown to actually
   * be hitting cache rather than assumed to be. Off unless
   * `ZERO_DEBUG_PROMPT_CACHE` is set — this fires once per agent turn, and an
   * unconditional line would interleave with the TUI on every scan.
   *
   * The same numbers reach the cloud without this flag: `cachedInputTokens`
   * flows into `ScanCostLedger` and the `scan_completed` cost breakdown, which
   * is the durable, queryable proof. This is the local fast path.
   */
  private logCacheUsage(usage: NativeRuntimeResult["usage"]): void {
    if (!usage || !process.env["ZERO_DEBUG_PROMPT_CACHE"]) return;
    const read = usage.cachedInputTokens ?? 0;
    const write = usage.cacheWriteTokens ?? 0;
    const hitRate = usage.inputTokens > 0
      ? Math.round((read / usage.inputTokens) * 100)
      : 0;
    diag.info("prompt_cache_usage", `prompt-cache ${this.providerLabel}`, {
      provider: this.providerLabel,
      read,
      write,
      uncached: usage.inputTokens - read - write,
      total_in: usage.inputTokens,
      hit_pct: hitRate,
    });
  }

  /** Friendly provider name for error messages. */
  private get providerLabel(): string {
    switch (this.provider) {
      case "openrouter": return "OpenRouter";
      case "anthropic": return "Anthropic";
      case "openai": return "OpenAI";
      case "azure": return "Azure OpenAI";
      case "deepseek": return "DeepSeek";
      case "chatgpt-plan": return "ChatGPT plan";
      case "chatgpt-codex": return "ChatGPT (Codex backend)";
      case "z-ai": return "Z.ai (GLM)";
      case "kimi": return "Kimi (Moonshot)";
      case "qwen": return "Qwen (Alibaba Model Studio)";
      case "xai": return "xAI (Grok)";
      case "opencode": return "OpenCode Zen";
      case "cline": return "Cline";
      case "together": return "Together AI";
      case "copilot": return "GitHub Copilot";
      case "google": return "Google Gemini (Code Assist)";
    }
  }

  private noKeyError(): string {
    return (
      "No provider credential found. Set one of:\n" +
      "  env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN=... 0 <command> (ChatGPT Codex subscription auth)\n" +
      "  export OPENROUTER_API_KEY=sk-or-...   (OpenRouter — many models, one key)\n" +
      "  export DEEPSEEK_API_KEY=...           (DeepSeek — direct Flash 0731 inference)\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...    (Anthropic — direct Claude access)\n" +
      "  export AZURE_OPENAI_API_KEY=...        (Azure OpenAI — reuse your Codex Azure provider)\n" +
      "  export OPENAI_API_KEY=sk-...           (OpenAI — direct GPT access)\n" +
      "  export Z_AI_API_KEY=...                (Z.ai GLM — flat-rate Coding Plan, Anthropic-compatible)\n" +
      "  export KIMI_API_KEY=...                (Moonshot Kimi K3 — flat-rate coding, Anthropic-compatible)\n" +
      "  export QWEN_API_KEY=...                (Alibaba Qwen — Token Plan sub, OpenAI-compatible)\n" +
      "  export XAI_API_KEY=...                 (xAI Grok — OpenAI-compatible)\n" +
      "  export CLINE_API_KEY=...               (Cline — API key; cline-pass/* needs ClinePass)\n" +
      "  export TOGETHER_API_KEY=...            (Together AI — open models; pin with ZERO_SELECTED_PROVIDER=together)\n" +
      "  export OPENCODE_API_KEY=...            (OpenCode Zen — multi-wire gateway)\n" +
      "  export ZERO_COPILOT_GITHUB_TOKEN=...   (GitHub Copilot — device-code OAuth token)"
    );
  }

  getConfigurationDiagnostics(): ApiRuntimeDiagnostics {
    // chatgpt-codex's "key" is an OAuth refresh token in env, not
    // a Platform API key field — skip the missing-key guard for it
    // and let the refresh attempt surface real errors at request time.
    if (!this.apiKey && this.provider !== "chatgpt-codex" && this.provider !== "chatgpt-plan") {
      return {
        valid: false,
        provider: this.provider,
        providerLabel: this.providerLabel,
        reason: "missing_key",
        fatalError: this.noKeyError(),
      };
    }

    if (this.provider !== "azure") {
      return {
        valid: true,
        provider: this.provider,
        providerLabel: this.providerLabel,
      };
    }

    const hasConfiguredBaseUrl = !!(
      this.env.AZURE_OPENAI_BASE_URL ||
      this.env.OPENAI_BASE_URL ||
      this.azureConfig.baseUrl
    );
    const hasConfiguredModel = !!(
      this.config.model ||
      this.env["ZERO_MODEL"] ||
      this.env.AZURE_OPENAI_MODEL ||
      this.azureConfig.model
    );

    const missing: string[] = [];
    if (!hasConfiguredBaseUrl) {
      missing.push("AZURE_OPENAI_BASE_URL (or [model_providers.azure].base_url in ~/.codex/config.toml)");
    }
    if (!hasConfiguredModel) {
      missing.push("AZURE_OPENAI_MODEL or an Azure-backed `model = \"...\"` in ~/.codex/config.toml");
    }

    if (missing.length > 0) {
      return {
        valid: false,
        provider: this.provider,
        providerLabel: this.providerLabel,
        reason: "invalid_config",
        fatalError:
          "Azure OpenAI runtime is selected, but the configuration is incomplete.\n" +
          `Missing: ${missing.join("; ")}\n` +
          "0 will not guess Azure defaults because that can silently route to the wrong endpoint or deployment.",
      };
    }

    return {
      valid: true,
      provider: this.provider,
      providerLabel: this.providerLabel,
    };
  }

  /**
   * POST to the provider endpoint and, on a retryable HTTP status
   * (429 rate-limit / transient 5xx), back off and retry — honoring a
   * `Retry-After` header when present, otherwise exponential backoff with
   * full jitter (so a burst of concurrent scans desynchronises instead of
   * hammering the limit in lockstep).
   *
   * Two 429 classes are handled differently:
   * - per-minute rate limit → retry with the wider 429 budget
   *   (ZERO_LLM_429_MAX_RETRIES attempts / ZERO_LLM_429_MAX_RETRY_WAIT_MS
   *   cumulative, defaults 12 / 5min) since the limiter resets every ~60s;
   *   `Retry-After` / `retry-after-ms` headers are honored up to a 120s cap.
   * - plan-quota exhaustion (`usage_limit_reached`, resets in hours/days) →
   *   skips retries and immediately advances `ZERO_LLM_FALLBACK`; if no
   *   configured fallback has credentials, it throws QuotaExhaustedError.
   *
   * Other retryable statuses (transient 5xx) keep the generic budget:
   * ZERO_LLM_MAX_RETRIES (attempts) and ZERO_LLM_MAX_RETRY_WAIT_MS
   * (cumulative backoff). On exhaustion it returns the last still-failing
   * Response with its body intact, so the caller's existing `!res.ok` branch
   * surfaces the clear "API error <status>" message — a rate-limit never
   * masquerades as silent no-work.
   *
   * Headers are re-resolved per attempt (via ensureFreshHeaders → OAuth
   * refresh) so a token that rotated during the wait is picked up. The body
   * is fixed across attempts.
   */
  /**
   * Try the next fallback provider in the chain (ZERO_LLM_FALLBACK).
   * Updates `this.provider`, `this.model`, `this.apiKey`, `this.baseUrl`,
   * `this.wireApi` to match the next valid provider. Returns `true` when a
   * valid next provider was found and switched to, `false` when the chain is
   * exhausted.
   */
  private _tryFailover(
    reason: "plan quota exhausted" | "429 retry budget exhausted" | "provider policy refusal",
  ): boolean {
    if (this.config.cyberAccessProgram !== undefined) return false;
    while (this.fallbackIndex < this.fallbackChain.length) {
      const entry = this.fallbackChain[this.fallbackIndex]!;
      this.fallbackIndex++;
      const cfg = entry.credentials;
      if (!cfg) {
        diag.warn(
          "failover_provider_skipped",
          `ZERO_LLM_FALLBACK: skipping ${entry.provider} (auth env missing)`,
          { provider: entry.provider, model: entry.model, cause: "auth-env-missing" },
        );
        continue;
      }
      this.provider = entry.provider;
      this.model = normalizeModelForProvider(entry.provider, entry.model);
      this.apiKey = cfg.apiKey;
      this.baseUrl = cfg.baseUrl;
      this.wireApi = cfg.wireApi;
      diag.warn(
        "failover_engaged",
        `${reason} — failover to ${entry.provider} (${this.model})`,
        { reason, provider: entry.provider, model: this.model },
      );
      return true;
    }
    return false;
  }

  /**
   * POST to the provider endpoint and, on a retryable HTTP status
   * (429 rate-limit / transient 5xx), back off and retry — honoring a
   * `Retry-After` header when present, otherwise exponential backoff with
   * full jitter (so a burst of concurrent scans desynchronises instead of
   * hammering the limit in lockstep).
   *
   * Socket failures retry only when local transport metadata proves the POST
   * was not dispatched. Closed/reset connections with an unknown outcome never
   * replay, including through the separate native-stream retry loop.
   *
   * The body factory is valid only for the current provider and wire protocol.
   * A null result signals failover so the caller rebuilds the complete request
   * under its existing timeout/cancellation signal.
   * Retry + failover caps documented on `retryBackoffMs` / `llm429MaxRetries`.
   *
   * Headers are re-resolved per attempt (via ensureFreshHeaders → OAuth
   * refresh) so a token that rotated during the wait is picked up.
   */
  private async gatewayRequestAdmission(signal: AbortSignal): Promise<RequestAdmission> {
    if (this.workbenchProviderProxy) throw new Error(`${LOCAL_ADMISSION_UNAVAILABLE} gateway admission cannot use a workbench proxy; no inference request sent`);
    const model = this.model;
    const baseUrl = this.baseUrl;
    const identity = JSON.stringify([this.provider, baseUrl, model, this.wireApi]);
    if (!this.requestAdmission || this.requestAdmissionIdentity !== identity) {
      this.requestAdmissionIdentity = identity;
      const pending = (async () => {
        try {
          // Same configured provider origin and credentials; redirects cannot move the capability.
          // foxguard: ignore[js/no-ssrf]
          const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
            headers: await this.ensureFreshHeaders(signal), signal, redirect: "error",
          });
          if (!response.ok) throw new Error(`${LOCAL_ADMISSION_UNAVAILABLE} catalog HTTP ${response.status}; no inference request sent`);
          return parseRequestAdmission(await response.json(), model);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith(LOCAL_ADMISSION_UNAVAILABLE)) throw error;
          throw new Error(`${LOCAL_ADMISSION_UNAVAILABLE} catalog unavailable or invalid; no inference request sent`);
        }
      })();
      this.requestAdmission = pending;
      void pending.catch(() => {
        // An older failed GET must not erase a newer route's successful cache.
        if (this.requestAdmission === pending && this.requestAdmissionIdentity === identity) {
          this.requestAdmission = undefined;
          this.requestAdmissionIdentity = undefined;
        }
      });
    }
    return this.requestAdmission;
  }

  private async postWithRetry(
    bodyFactory: () => string,
    signal: AbortSignal,
    abort?: CallAbort,
  ): Promise<Response | null> {
    let waited429Ms = 0;
    let waitedOtherMs = 0;
    for (let attempt = 0; ; attempt++) {
      // Operator cancellation is TERMINAL, checked before every attempt so a
      // signal that fired during a backoff wait, a body read or an OAuth
      // refresh never gets a request issued for it. `abort` is undefined for
      // every caller that passes no operator signal, making this a no-op.
      abort?.throwIfCancelled();
      if (this.siwcConnection) {
        this.siwcModels ??= listSiwcModels(this.siwcConnection, fetch, signal).then(models => new Set(models.map(model => model.slug)));
        try {
          if (!(await this.siwcModels).has(this.model)) throw new Error("Selected model is not in this ChatGPT account's available catalog");
        } catch (error) { this.siwcModels = undefined; throw error; }
      }
      let body = bodyFactory();
      if (this.config.cyberAccessProgram !== undefined) {
        this.assertAccessProgramRoute();
        body = JSON.stringify({ ...JSON.parse(body), access_programs: { cyber: this.config.cyberAccessProgram } });
      }
      if (this.env["ZERO_REQUIRE_REQUEST_ADMISSION"] === "1") {
        assertRequestAdmission(body, await this.gatewayRequestAdmission(signal));
      }
      let res: Response;
      try {
        // buildUrl() is the configured LLM provider endpoint (operator-set via
        // provider config / ZERO_* env), never user/attacker input; same
        // trusted endpoint the client already POSTed to, now wrapped in retry.
        // foxguard: ignore[js/no-ssrf]
        res = this.grantedProviderTransport ? await this.grantedProviderTransport.request({ provider: "chatgpt-codex", model: this.model, body }, signal) : this.workbenchProviderProxy ? await fetch(this.workbenchProviderProxy.url, {
          method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: this.provider, model: this.model, body }), signal,
        }) : await fetch(this.buildUrl(), {
          method: "POST",
          // Bun's pooled sockets can close between inference calls. A fresh
          // OpenRouter connection avoids reusing one without replaying a POST.
          // https://bun.sh/docs/runtime/networking/fetch#request-options
          ...(this.provider === "openrouter" && typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? { keepalive: false } : {}),
          redirect: "error",
          headers: await this.ensureFreshHeaders(signal),
          body,
          signal,
        });
      } catch (error) {
        // An operator abort rejects `fetch` with an anonymous AbortError that
        // is indistinguishable from a timeout abort at this level. Reclassify
        // it FIRST so it can never be treated as a retryable transport fault
        // or wrapped as a "transport failure".
        abort?.throwIfCancelled();
        const failure = classifyTransportFailure(error);
        // A remote granted transport's error is not proof about whether its
        // controller already dispatched inference; only local socket metadata is.
        if (this.grantedProviderTransport || !failure.beforeDispatch) throw new Error(unknownTransportOutcome(this.providerLabel, failure), { cause: error });
        if (this.env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] === "1") {
          throw new Error(`${this.providerLabel} connection failed before inference dispatch [${failure.code}]. Automatic replay is disabled by the configured retry policy`, { cause: error });
        }
        const maxRetries = llmMaxRetries();
        const maxWaitMs = llmMaxRetryWaitMs();
        const delay = retryBackoffMs(attempt);
        if (attempt < maxRetries && waitedOtherMs + delay <= maxWaitMs && !signal.aborted) {
          diag.warn("transport_retry", `${this.providerLabel} pre-dispatch transport ${failure.code} — backoff ${delay}ms`, {
            provider: this.providerLabel, cause_code: failure.code, delay_ms: delay,
            attempt: attempt + 1, max_retries: maxRetries,
          });
          waitedOtherMs += delay;
          await sleepWithAbort(delay, signal);
          continue;
        }
        throw new Error(`${this.providerLabel} connection failed before inference dispatch [${failure.code}]: ${failure.message}`, { cause: error });
      }
      if (!res.ok && this.env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] === "1" && res.headers.get("x-0-retry-safe") !== "1") {
        await res.body?.cancel();
        throw new Error(`${this.providerLabel} gateway HTTP ${res.status}; request outcome may be unknown. Automatic replay is disabled`);
      }
      if (res.ok || !isRetryableHttpStatus(res.status)) {
        return res;
      }

      // Past this point every branch either retries or fails over to another
      // provider. Both are exactly wrong after an operator cancellation, so
      // this single guard covers the quota-failover, 429-failover and
      // backoff-and-retry branches below at once.
      abort?.throwIfCancelled();

      const is429 = res.status === 429;
      // A 429 body distinguishes per-minute rate limiting (retry) from plan-
      // quota exhaustion (advance configured fallback without retry), so it
      // must be read to classify. If the response is handed back below, it is
      // re-wrapped with the same body.
      let bodyText: string | undefined;
      if (is429) {
        try {
          bodyText = await res.text?.();
        } catch {
          bodyText = undefined;
        }
        const quota =
          bodyText != null ? parseUsageLimitReached(bodyText) : undefined;
        if (quota) {
          const resetsAtIso =
            quota.resetsAtMs != null
              ? new Date(quota.resetsAtMs).toISOString()
              : "unknown";
          appendNativeTrace({
            kind: "quota-exhausted",
            provider: this.providerLabel,
            status: res.status,
            planType: quota.planType ?? null,
            resetsAtMs: quota.resetsAtMs ?? null,
          });
          const quotaKind = quota.quotaKind ?? "quota_exhausted";
          diag.error(
            "quota_exhausted",
            `${this.providerLabel} ${quotaKind} — plan quota exhausted; skipping retry`,
            {
              provider: this.providerLabel,
              quota_kind: quotaKind,
              plan: quota.planType ?? "unknown",
              resets_at: resetsAtIso,
              status: res.status,
            },
          );
          const quotaError = new QuotaExhaustedError(
            `${this.providerLabel} ${quotaKind}: plan quota exhausted ` +
              `(plan=${quota.planType ?? "unknown"}, resets_at=${resetsAtIso}) ` +
              `— reschedulable after reset`,
            quota,
          );
          if (this._tryFailover("plan quota exhausted")) {
            return null;
          }
          throw quotaError;
        }
      }

      const maxRetries = is429 ? llm429MaxRetries() : llmMaxRetries();
      const maxWaitMs = is429 ? llm429MaxRetryWaitMs() : llmMaxRetryWaitMs();
      const waitedMs = is429 ? waited429Ms : waitedOtherMs;
      // Hand the last still-failing Response back with its body intact.
      const handBack = (): Response =>
        is429 && bodyText != null
          ? new Response(bodyText, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            })
          : res;
      if (attempt >= maxRetries) {
        // 429 budget exhausted — try cross-provider failover before giving up.
        if (is429 && this._tryFailover("429 retry budget exhausted")) {
          return null;
        }
        return handBack();
      }
      const retryAfter = is429
        ? retryAfterMsFromHeaders(res.headers)
        : parseRetryAfterMs(res.headers?.get?.("retry-after"));
      const delay = retryAfter ?? retryBackoffMs(attempt, is429 ? 30_000 : 20_000);
      if (waitedMs + delay > maxWaitMs) {
        // 429 cumulative backoff budget exhausted — try cross-provider failover.
        if (is429 && this._tryFailover("429 retry budget exhausted")) {
          return null;
        }
        return handBack();
      }
      // Drain the failed response so the socket is released before retrying
      // (429 bodies were already consumed above for classification).
      if (!is429) {
        try {
          await res.text?.();
        } catch {
          // best-effort — a mocked/streamed body may not expose text()
        }
      }
      appendNativeTrace({
        kind: "retry",
        provider: this.providerLabel,
        status: res.status,
        attempt: attempt + 1,
        delayMs: delay,
        retryAfterHonored: retryAfter != null,
      });
      diag.warn(
        "retry_backoff",
        `${this.providerLabel} HTTP ${res.status} — backoff ${delay}ms`,
        {
          provider: this.providerLabel,
          status: res.status,
          delay_ms: delay,
          attempt: attempt + 1,
          max_retries: maxRetries,
          budget_used_ms: waitedMs,
          budget_max_ms: maxWaitMs,
          retry_after_honored: retryAfter != null,
        },
      );
      if (is429) {
        waited429Ms += delay;
      } else {
        waitedOtherMs += delay;
      }
      await sleepWithAbort(delay, signal);
    }
  }

  // ── Legacy Runtime interface (single-prompt) ──

  async execute(prompt: string, context?: RuntimeContext): Promise<RuntimeResult> {
    return this.accessProgramObservation.run({}, () => this.executeWithObservation(prompt, context));
  }

  private async executeWithObservation(prompt: string, context?: RuntimeContext): Promise<RuntimeResult> {
    this.assertAccessProgramRoute();
    this.observedAccessProgram = undefined;
    const selectionEpoch = this.accessProgramSelectionEpoch;
    try { return await this.executeWithProgram(prompt, context); }
    finally {
      this.retainAccessProgramReceipt(selectionEpoch);
    }
  }

  private async executeWithProgram(
    prompt: string,
    context?: RuntimeContext,
  ): Promise<RuntimeResult> {
    const start = Date.now();
    if (context?.signal?.aborted) {
      return { output: "", exitCode: null, timedOut: false, durationMs: 0, error: "API execution cancelled." };
    }
    if (this.siwcConnection || this.grantedProviderTransport || this.workbenchProviderProxy) {
      const result = await this.executeNative(context?.systemPrompt ?? "", [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ], [], undefined, context?.signal);
      return {
        output: result.content.filter((block): block is Extract<NativeContentBlock, { type: "text" }> => block.type === "text").map(block => block.text).join("\n"),
        exitCode: result.cancelled ? null : result.stopReason === "error" ? 1 : 0,
        timedOut: result.timedOut === true, durationMs: Date.now() - start, usage: result.usage, error: result.error,
      };
    }

    // chatgpt-codex and google (Code Assist) authenticate via an OAuth bearer
    // refreshed on demand, not a Platform API key field — skip the missing-key
    // guard for them and let the refresh surface real errors at request time.
    if (!this.apiKey && this.provider !== "chatgpt-codex" && this.provider !== "chatgpt-plan" && this.provider !== "google") {
      return {
        output: "",
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - start,
        error: this.noKeyError(),
      };
    }

    const systemPrompt = context?.systemPrompt ?? "";

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeout || 120_000,
    );
    const abort = composeCallAbort(controller.signal, context?.signal);

    try {
      let res: Response | null;
      do {
        abort.throwIfCancelled();

        if (this.isOpenAICompat && this.wireApi === "chat_completions") {
          // OpenRouter / OpenAI / Azure chat completions format
          const messages: Array<Record<string, string>> = [];
          if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
          }
          messages.push({ role: "user", content: prompt });

          res = await this.postWithRetry(
            () => JSON.stringify({
              model: this.model,
              ...(this.provider === "cline" ? { stream: false } : {}),
              [this.maxTokensParamKey]: NATIVE_COMPLETION_TOKEN_LIMIT,
              messages,
              // See executeNative: explicit reasoning_effort passthrough only.
              ...(this.reasoningEffort
                ? { reasoning_effort: this.reasoningEffort }
                : {}),
            }),
            abort.signal, abort,
          );
        } else if (this.isOpenAICompat && this.wireApi === "responses") {
          // Azure Responses API format
          const input: Array<Record<string, unknown>> = [];
          if (systemPrompt) {
            input.push({
              role: "system",
              content: [{ type: "input_text", text: systemPrompt }],
            });
          }
          input.push({
            role: "user",
            content: [{ type: "input_text", text: prompt }],
          });

          const isCodex = this.provider === "chatgpt-codex";
          res = await this.postWithRetry(
            () => JSON.stringify({
              model: this.model,
              input,
              ...(isCodex ? { store: false } : { max_output_tokens: NATIVE_COMPLETION_TOKEN_LIMIT }),
              ...(this.provider === "chatgpt-plan" ? { store: false, stream: true } : {}),
            }),
            abort.signal, abort,
          );
        } else if (this.isGeminiCodeAssist) {
          // Same inner request as the Google generateContent wire, wrapped in
          // the Code Assist `{ model, project, user_prompt_id, request }` envelope.
          const request: Record<string, unknown> = {
            ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: NATIVE_COMPLETION_TOKEN_LIMIT },
          };
          const geminiBody = await this.wrapGeminiCodeAssistBody(request);
          res = await this.postWithRetry(() => JSON.stringify(geminiBody), abort.signal, abort);
        } else if (this.isGoogleWire) {
          res = await this.postWithRetry(
            () => JSON.stringify({
              ...(systemPrompt
                ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
                : {}),
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: NATIVE_COMPLETION_TOKEN_LIMIT },
            }),
            abort.signal, abort,
          );
        } else if (this.isAnthropicWire) {
          // Anthropic Messages API format (also serves the z-ai/GLM and
          // kimi/Moonshot providers — see `isAnthropicWire`).
          res = await this.postWithRetry(
            () => JSON.stringify({
              model: this.model,
              max_tokens: NATIVE_COMPLETION_TOKEN_LIMIT,
              ...this.anthropicThinkingField(),
              ...(systemPrompt ? { system: systemPrompt } : {}),
              messages: [{ role: "user", content: prompt }],
            }),
            abort.signal, abort,
          );
        } else {
          throw new Error(`execute: provider ${this.provider} is not mapped to a wire`);
        }
      } while (!res);


      const body = await res.text();

      if (!res.ok) {
        appendNativeTrace({
          kind: "error-response",
          provider: this.providerLabel,
          status: res.status,
          body: body.slice(0, 2000),
        });
        return {
          output: "",
          exitCode: 1,
          timedOut: false,
          durationMs: Date.now() - start,
          error: `${this.providerLabel} API error ${res.status}: ${body.slice(0, 500)}`,
        };
      }

      const parsedBody = JSON.parse(body);
      this.observeAccessProgram(parsedBody);
      // Code Assist wraps the whole generateContent response in `{ response }`;
      // unwrap it so the shared Google parser (below) sees the native shape.
      const json = this.provider === "cline" ? clineChatResponse(parsedBody)
        : this.isGeminiCodeAssist ? (parsedBody.response ?? parsedBody) : parsedBody;

      // Extract text from response (different formats)
      let text: string;
      if (this.isOpenAICompat && this.wireApi === "chat_completions") {
        const msg = json.choices?.[0]?.message;
        // Some models (reasoning models) return content: null with reasoning field
        text = msg?.content ?? msg?.reasoning ?? "";
      } else if (this.isOpenAICompat && this.wireApi === "responses") {
        text =
          typeof json.output_text === "string" && json.output_text.trim()
            ? json.output_text
            : Array.isArray(json.output)
              ? json.output
                  .flatMap((item: Record<string, unknown>) => Array.isArray(item.content) ? item.content : [])
                  .filter((block: Record<string, unknown>) => block.type === "output_text")
                  .map((block: Record<string, unknown>) => String(block.text ?? ""))
                  .join("\n")
              : "";
      } else if (this.isGoogleWire || this.isGeminiCodeAssist) {
        text =
          json.candidates?.[0]?.content?.parts
            ?.filter((part: Record<string, unknown>) => typeof part.text === "string")
            .map((part: Record<string, unknown>) => part.text as string)
            .join("\n") ?? "";
      } else {
        // Anthropic Messages response (also z-ai/GLM + kimi/Moonshot).
        text =
          json.content
            ?.filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join("\n") ?? "";
      }

      let usage: RuntimeResult["usage"];
      if (this.isAnthropicWire) {
        usage = readCacheUsage(json.usage);
      } else if ((this.isGoogleWire || this.isGeminiCodeAssist) && json.usageMetadata) {
        usage = readGoogleUsage(json.usageMetadata);
      } else if (this.isOpenAICompat && json.usage) {
        usage = this.wireApi === "chat_completions"
          ? readChatUsage(json.usage)
          : readResponsesUsage(json.usage);
      }

      return {
        output: text,
        exitCode: 0,
        timedOut: false,
        durationMs: Date.now() - start,
        ...(usage ? { usage } : {}),
      };
    } catch (err) {
      clearTimeout(timer);
      if (abort.operatorAborted()) {
        return { output: "", exitCode: null, timedOut: false, durationMs: Date.now() - start, error: "API execution cancelled." };
      }
      if (err instanceof QuotaExhaustedError) {
        // Plan-quota exhaustion: fail fast with the distinct, greppable
        // message (carries usage_limit_reached + resets_at) — never retried.
        return {
          output: "",
          exitCode: 1,
          timedOut: false,
          durationMs: Date.now() - start,
          error: err.message,
        };
      }
      let msg = err instanceof Error ? err.message : String(err);
      const transport = classifyTransportFailure(err);
      if (["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "CONNECTION_CLOSED"].includes(transport.code)
          && !/automatic replay (?:is )?disabled/i.test(msg)) msg = unknownTransportOutcome(this.providerLabel, transport);
      const unknownOutcome = /automatic replay (?:is )?disabled|outcome.{0,30}unknown/i.test(msg);
      // A transport may sanitize AbortError into a generic cancellation message.
      // Operator-first cancellation was handled above; our timer remains authoritative.
      const timedOut = controller.signal.aborted || msg.includes("abort") || msg.includes("timeout");
      return {
        output: "",
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - start,
        error: timedOut
          ? `${this.providerLabel} API request timed out${unknownOutcome ? "; request outcome may be unknown. Automatic replay is disabled" : ""}`
          : `${this.providerLabel} API error: ${msg}`,
      };
    }
    finally {
      clearTimeout(timer);
      abort.dispose();
    }
  }

  // ── Native Runtime interface (structured messages + tool_use) ──

  /** Terminal result for an operator cancellation — `stopReason:"error"` for compatibility, `cancelled:true` for consumers that can tell the difference. */
  private cancelledResult(start: number): NativeRuntimeResult {
    return {
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      cancelled: true,
      durationMs: Date.now() - start,
      error: `${this.providerLabel} request cancelled by operator`,
    };
  }

  /** Public entry point. Retries a transient empty stream with bounded backoff. */
  async executeNative(system: string, messages: NativeMessage[], tools: NativeToolDef[], callbacks?: NativeStreamCallbacks, signal?: AbortSignal): Promise<NativeRuntimeResult> {
    return this.accessProgramObservation.run({}, () => this.executeNativeWithObservation(system, messages, tools, callbacks, signal));
  }

  private async executeNativeWithObservation(system: string, messages: NativeMessage[], tools: NativeToolDef[], callbacks?: NativeStreamCallbacks, signal?: AbortSignal): Promise<NativeRuntimeResult> {
    this.assertAccessProgramRoute();
    this.observedAccessProgram = undefined;
    const selectionEpoch = this.accessProgramSelectionEpoch;
    try {
      const result = await this.executeNativeWithRecovery(system, messages, tools, callbacks, signal);
      if (this.config.cyberAccessProgram !== undefined) result.accessProgram = { requested: this.config.cyberAccessProgram, ...(this.observedAccessProgram ? { confirmed: this.observedAccessProgram } : {}) };
      return result;
    } finally {
      this.retainAccessProgramReceipt(selectionEpoch);
    }
  }

  private async executeNativeWithRecovery(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult> {
    const maxAttempts = llmStreamMaxAttempts();
    let result!: NativeRuntimeResult;
    let attempt = 0;
    // Usage reported by refused attempts, carried onto the final result so a
    // failover hand-off never silently drops tokens the provider says it
    // consumed while evaluating the refused request.
    let refusedUsage: NativeRuntimeResult["usage"];
    const withRefusedUsage = (outcome: NativeRuntimeResult): NativeRuntimeResult => refusedUsage
      ? { ...outcome, usage: mergeRuntimeUsage(outcome.usage, refusedUsage) }
      : outcome;
    for (;;) {
      result = await this.executeNativeAttempt(system, messages, tools, callbacks, signal);
      if (isLocalAdmissionFailure(result.error)) return withRefusedUsage(result);
      if (this.env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] === "1" && (result.stopReason === "error" || result.error)) {
        return withRefusedUsage({ ...result, error: `${result.error ?? "Incomplete gateway response"}. Request outcome may be unknown. Automatic replay is disabled` });
      }
      if (isPolicyRefusalResult(result) && !signal?.aborted) {
        if (result.usage) refusedUsage = mergeRuntimeUsage(refusedUsage, result.usage);
        if (this._tryFailover("provider policy refusal")) continue;
        // Chain exhausted: return the refusal immediately with every refused
        // leg's usage merged (this result's usage is already included).
        return refusedUsage ? { ...result, usage: refusedUsage } : result;
      }
      attempt++;
      if (attempt >= maxAttempts || !shouldRetryNativeStream(result) || signal?.aborted) break;

      const backoff = streamRetryBackoffMs(attempt);
      diag.warn(
        "stream_retry",
        `${this.providerLabel} stream ended without a final response — retrying (attempt ${attempt + 1}/${maxAttempts}) after ${backoff}ms`,
        { provider: this.providerLabel, attempt: attempt + 1, max_attempts: maxAttempts, backoff_ms: backoff },
      );
      await delayWithAbort(backoff, signal);
      if (signal?.aborted) break;
    }

    // Genuinely exhausted the retry budget on a still-transient outcome (as
    // opposed to breaking early for an abort): keep failing the turn but make
    // the message say it retried, so the operator (and the logs) can tell a
    // persistent empty stream from a one-off blip.
    if (attempt >= maxAttempts && maxAttempts > 1 && shouldRetryNativeStream(result)) {
      return withRefusedUsage({ ...result, error: `${result.error} (retried ${maxAttempts} times)` });
    }
    return withRefusedUsage(result);
  }

  private async executeNativeAttempt(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult> {
    const start = Date.now();

    // chatgpt-codex and google (Code Assist) authenticate via an OAuth bearer
    // refreshed on demand, not a Platform API key field — skip the missing-key
    // guard for them and let the refresh surface real errors at request time.
    if (!this.apiKey && this.provider !== "chatgpt-codex" && this.provider !== "chatgpt-plan" && this.provider !== "google") {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error: this.noKeyError(),
      };
    }

    // Already cancelled before we started: no request, no timer, no OAuth
    // refresh, no body construction. The console re-checks its signal between
    // rounds, so this is the common shape of "Esc pressed during a tool run".
    if (signal?.aborted) return this.cancelledResult(start);


    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeout || 120_000,
    );
    // The timeout controller above is untouched; `call.signal` is it verbatim
    // when no operator signal was passed, and the union of the two otherwise.
    const call = composeCallAbort(controller.signal, signal);

    try {
      let res: Response | null;
      do {

        if (this.isOpenAICompat && this.wireApi === "chat_completions") {
          // Convert to OpenAI chat completions format
          const chatMessages: Array<Record<string, unknown>> = [];
          chatMessages.push({ role: "system", content: system });

          for (const m of messages) {
            if (m.role === "user" && m.content.some(block => block.type === "image") && m.content.every(block => block.type === "text" || block.type === "image")) {
              chatMessages.push({ role: "user", content: m.content.map(block => block.type === "image"
                ? { type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
                : { type: "text", text: block.type === "text" ? block.text : "" }) });
              continue;
            }
            // Batch all tool_use blocks from the same message into a
            // single assistant message with a tool_calls array. gpt-5+
            // strictly validates that every assistant with tool_calls is
            // immediately followed by tool responses for each call id —
            // splitting one turn into multiple assistant messages breaks
            // that invariant and produces a 400 from Azure.
            type ToolCall = {
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            };
            const pendingToolCalls: ToolCall[] = [];
            let pendingAssistantText: string | null = null;
            const flushAssistant = (): void => {
              if (pendingToolCalls.length === 0 && pendingAssistantText === null) return;
              const msg: Record<string, unknown> = { role: "assistant" };
              if (pendingAssistantText !== null) msg.content = pendingAssistantText;
              else msg.content = null;
              if (pendingToolCalls.length > 0) msg.tool_calls = pendingToolCalls.slice();
              chatMessages.push(msg);
              pendingToolCalls.length = 0;
              pendingAssistantText = null;
            };

            for (const block of m.content) {
              if (block.type === "text") {
                if (m.role === "assistant") {
                  pendingAssistantText = (pendingAssistantText ?? "") + block.text;
                } else {
                  flushAssistant();
                  chatMessages.push({ role: m.role, content: block.text });
                }
              } else if (block.type === "image") {
                flushAssistant();
                chatMessages.push({ role: m.role, content: [{ type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.data}` } }] });
              } else if (block.type === "tool_use") {
                pendingToolCalls.push({
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: JSON.stringify(block.input) },
                });
              } else if (block.type === "tool_result") {
                flushAssistant();
                chatMessages.push({
                  role: "tool",
                  tool_call_id: block.tool_use_id,
                  content: block.content,
                });
              }
            }
            // End-of-message flush so a turn that ends with tool_use
            // blocks emits one assistant message with the full tool_calls
            // array before the next turn's tool_results land.
            flushAssistant();
          }

          const body: Record<string, unknown> = {
            model: this.model,
            // Cline defaults to SSE; this path consumes a complete JSON response.
            ...(this.provider === "cline" ? { stream: false } : {}),
            [this.maxTokensParamKey]: NATIVE_COMPLETION_TOKEN_LIMIT,
            messages: chatMessages,
          };

          // reasoning_effort on the chat_completions wire — only when the
          // operator set it explicitly (ZERO_REASONING_EFFORT / Azure config).
          // DeepSeek direct honors it (measured 4x reasoning-token separation,
          // 2026-08-12); endpoints that don't know the field (Alibaba
          // compatible-mode) silently ignore it. Never apply the gpt-5/o1
          // default here — default request shape must stay byte-identical.
          if (this.reasoningEffort) {
            body.reasoning_effort = this.reasoningEffort;
          }

          if (tools.length > 0) {
            body.tools = tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              },
            }));
          }

          res = await this.postWithRetry(
            () => JSON.stringify({ ...body, model: this.model }),
            call.signal,
            call,
          );
        } else if (this.isOpenAICompat && this.wireApi === "responses") {
          // Responses API uses a flat list of items, not role-based messages.
          // function_call and function_call_output are top-level items, not nested
          // inside content arrays. See: developers.openai.com/docs/api-reference/responses
          //
          // ChatGPT Codex backend deviates: the system/developer prompt MUST
          // travel as the top-level `instructions` body field, not as a
          // role:"system" item inside `input`. A request without `instructions`
          // gets a 400 `{"detail":"Instructions are required"}` regardless of
          // what's in `input`. Send the prompt as `instructions` for codex and
          // skip the in-input system message.
          const isCodexProvider = this.provider === "chatgpt-codex" || this.provider === "chatgpt-plan";
          const input: Array<Record<string, unknown>> = isCodexProvider
            ? []
            : [
              {
                role: "system",
                content: [{ type: "input_text", text: system }],
              },
            ];

          for (const m of messages) {
            // ── Retained reasoning ──
            // When this assistant turn carries the provider's own item array AND
            // it was produced by exactly this provider+model+wireApi, replay it
            // verbatim. That is the only supported way to return encrypted
            // reasoning on this backend: `previous_response_id` is unsupported,
            // and a field-by-field reconstruction cannot honour "a reasoning item
            // must be immediately followed by the item it produced" — the flush
            // below emits pending text as a `{role, content}` message BEFORE the
            // function_call, which would land a message between the two and 400
            // with `Item 'rs_…' … without its required following item`.
            //
            // The `continue` is load-bearing: falling through would emit the raw
            // items AND their reconstructed twins.
            //
            // Any identity mismatch degrades to today's exact behaviour, which is
            // also the model-switch strip point — encrypted reasoning is bound to
            // the model that produced it. That covers the ensemble runtime
            // (`openrouter.ts`), which hands ONE shared messages array to N models
            // and appends the winner's turn back: every non-producing model sees a
            // mismatch and reconstructs, instead of 400-ing on a sibling's items.
            if (
              features.retainedReasoning
              && m.role === "assistant"
              && m.providerRaw
              && m.providerRaw.provider === this.provider
              && m.providerRaw.model === this.model
              && m.providerRaw.wireApi === this.wireApi
              && m.providerRaw.output.length > 0
            ) {
              input.push(...(m.providerRaw.output as Array<Record<string, unknown>>));
              continue;
            }

            // Collect text blocks into a role-based message. The OpenAI Responses
            // API distinguishes text content by producer: user/system/developer
            // roles use `input_text`, but the assistant role must use
            // `output_text` (or `refusal`). Sending `input_text` on an assistant
            // message yields a 400 on Azure with:
            //   "Invalid value: 'input_text'. Supported values are:
            //    'output_text' and 'refusal'."
            // The agent loop replays the assistant's prior text replies on every
            // turn, so this bug used to kill every multi-turn scan on Azure
            // starting at turn 2 — the error was misdiagnosed as a "max turns
            // without completion" because each retry failed with the same 400.
            const assistantText = m.role === "assistant";
            const textType = assistantText ? "output_text" : "input_text";
            const textBlocks: Array<Record<string, unknown>> = [];
            for (const block of m.content) {
              if (block.type === "text") {
                textBlocks.push({ type: textType, text: block.text });
              } else if (block.type === "image") {
                textBlocks.push({ type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}` });
              } else if (block.type === "tool_use") {
                // Flush any pending text blocks first
                if (textBlocks.length > 0) {
                  input.push({ role: m.role, content: [...textBlocks] });
                  textBlocks.length = 0;
                }
                // Assistant tool_use → top-level function_call item
                input.push({
                  type: "function_call",
                  call_id: block.id,
                  ...(this.provider === "chatgpt-plan" ? { namespace: "zero" } : {}),
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                });
              } else if (block.type === "tool_result") {
                // Flush any pending text blocks first
                if (textBlocks.length > 0) {
                  input.push({ role: m.role, content: [...textBlocks] });
                  textBlocks.length = 0;
                }
                // Tool result → top-level function_call_output item
                input.push({
                  type: "function_call_output",
                  call_id: block.tool_use_id,
                  output: block.content,
                });
              }
            }
            // Flush remaining text blocks
            if (textBlocks.length > 0) {
              input.push({ role: m.role, content: textBlocks });
            }
          }

          const reasoningEffort = this.reasoningEffort ?? defaultReasoningEffort(this.model);
          // Codex backend rejects `max_output_tokens` set explicitly +
          // expects `store: false` to stay stateless (opencode
          // transform.ts:1056-1063 sets these for every Responses
          // request). For the public Platform API path keep the
          // explicit cap so we stay budget-bounded. Diff is per-key,
          // not per-shape — same body otherwise.
          const isCodex = this.provider === "chatgpt-codex";
          const body: Record<string, unknown> = {
            model: this.model,
            ...(this.provider === "chatgpt-plan" ? { store: false, stream: true } : {}),
            input,
            ...(isCodex || this.provider === "chatgpt-plan"
              ? { store: false, instructions: system }
              : { max_output_tokens: NATIVE_COMPLETION_TOKEN_LIMIT }),
            ...(reasoningEffort
              ? {
                reasoning: {
                  effort: reasoningEffort,
                  summary: "auto",
                },
                include: ["reasoning.encrypted_content"],
              }
              : {}),
            // Server-side compaction, opt-in per runtime. ZDR-friendly: it works
            // with `store: false`, so nothing is retained server-side between
            // requests. Only the loops with no context strategy of their own ask
            // for it — the native loop compacts client-side and must not be
            // compacted twice.
            //
            // SHAPE IS LOAD-BEARING and was verified live against
            // chatgpt.com/backend-api/codex/responses, because this backend
            // rejects unknown and mis-typed body fields rather than ignoring
            // them (a bogus field returns
            // `400 Unsupported parameter: <name>`):
            //   [{"type":"compaction","compact_threshold":N}]  → 200
            //   {"compaction":{"compact_threshold":N}}         → 400 expected an
            //                                                    array of objects
            //   [{"compaction":{...}}]                         → 400 missing
            //                                                    'context_management[0].type'
            //   []                                             → 400 minimum
            //                                                    length 1
            // The object form is what the public Responses docs show; it is not
            // what this backend takes. Never emit the key with an empty array —
            // that is a hard 400, hence the guard rather than a `.filter()`.
            //
            // Only the two stages that opt in send this, and they run on the
            // Codex backend. The shape is UNVERIFIED on plain OpenAI / Azure
            // Responses; if a caller ever enables it there, verify with a live
            // request before trusting it.
            ...(this.serverCompactionTokens
              ? {
                context_management: [
                  { type: "compaction", compact_threshold: this.serverCompactionTokens },
                ],
              }
              : {}),
          };

          if (tools.length > 0) {
            body.tools = tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              // Codex backend's Responses API expects `strict` alongside
              // parameters. `false` keeps schema enforcement off so a model
              // that drifts on argument shape still emits the call instead
              // of failing it server-side. The public OpenAI Responses
              // schema tolerates the extra field.
              strict: false,
              parameters: t.input_schema,
            }));
            if (this.provider === "chatgpt-plan") body.tools = [{ type: "namespace", name: "zero", description: "0 local investigation tools", tools: body.tools }];
            if (isCodex) {
              // Every reference Codex client (openai/codex,
              // glowbom/glowby) sets these. Omitting them shouldn't be
              // fatal — the backend doesn't 400 — but it leaves the
              // tool-invocation policy implicit. Setting them explicitly
              // matches the canonical client behaviour and rules out a
              // server-side default that gates tool use.
              body.tool_choice = "auto";
              body.parallel_tool_calls = true;
            }
          }

          res = await this.postWithRetry(
            () => JSON.stringify({ ...body, stream: true, model: this.model }),
            call.signal,
            call,
          );
          if (!res) continue;
          if (!res.ok) {
            const responseText = await res.text();
            clearTimeout(timer);
            return {
              content: [{ type: "text", text: "" }],
              stopReason: "error",
              durationMs: Date.now() - start,
              error: `${this.providerLabel} API error ${res.status}: ${responseText.slice(0, 500)}`,
            };
          }

          const streamed = await this.consumeResponsesStream(res, start, callbacks, {
            idleTimeoutMs: llmStreamIdleTimeoutMs(),
            eventIdleTimeoutMs: llmStreamEventIdleTimeoutMs(),
            abort: call,
          });
          clearTimeout(timer);
          return streamed;
        } else if (this.isGeminiCodeAssist) {
          // Build the native Google generateContent request (identical to the
          // isGoogleWire branch below), then wrap it in the Code Assist envelope.
          const request: Record<string, unknown> = {
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: this.googleContents(messages),
            generationConfig: { maxOutputTokens: NATIVE_COMPLETION_TOKEN_LIMIT },
          };
          if (tools.length > 0) {
            request.tools = [{
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.input_schema,
              })),
            }];
          }
          const geminiBody = await this.wrapGeminiCodeAssistBody(request);
          res = await this.postWithRetry(
            () => JSON.stringify(geminiBody),
            call.signal,
            call,
          );
        } else if (this.isGoogleWire) {
          const body: Record<string, unknown> = {
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: this.googleContents(messages),
            generationConfig: { maxOutputTokens: NATIVE_COMPLETION_TOKEN_LIMIT },
          };
          if (tools.length > 0) {
            body.tools = [{
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.input_schema,
              })),
            }];
          }
          res = await this.postWithRetry(
            () => JSON.stringify(body),
            call.signal,
            call,
          );
        } else if (this.isAnthropicWire) {
          // Anthropic Messages API format (also serves the z-ai/GLM and
          // kimi/Moonshot providers — see `isAnthropicWire`).
          const replayedRawMessageIndexes = new Set<number>();
          const apiMessages: Array<{ role: string; content: WireBlock[] }> = messages.map((m, index) => {
            // Anthropic requires an assistant turn containing thinking or
            // redacted_thinking to be echoed back EXACTLY as received. Rebuilding
            // it from visible text/tool blocks drops the signature and 400s on the
            // next tool-use turn. The full response content array keeps each
            // thinking block adjacent to the text/tool_use item it produced.
            if (
              features.retainedReasoning
              && m.role === "assistant"
              && m.providerRaw
              && m.providerRaw.provider === this.provider
              && m.providerRaw.model === this.model
              && m.providerRaw.wireApi === this.wireApi
              && m.providerRaw.output.length > 0
              && isWireBlockArray(m.providerRaw.output)
            ) {
              replayedRawMessageIndexes.add(index);
              return { role: m.role, content: m.providerRaw.output };
            }

            return {
              role: m.role,
              content: m.content.map((block): WireBlock => {
                if (block.type === "text") return { type: "text", text: block.text };
                if (block.type === "image") return { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } };
                if (block.type === "tool_use") {
                  return { type: "tool_use", id: block.id, name: block.name, input: block.input };
                }
                if (block.type === "tool_result") {
                  return {
                    type: "tool_result",
                    tool_use_id: block.tool_use_id,
                    content: block.content,
                    ...(block.is_error ? { is_error: true } : {}),
                  };
                }
                // Unreachable for the current block union (`block` narrows to
                // `never` here); kept as the original passthrough so an added
                // block kind degrades to "sent as-is" rather than being dropped.
                return block;
              }),
            };
          });

          // ── Prompt caching ──
          // Only Anthropic (and explicitly opted-in Anthropic-compatible
          // endpoints) get `cache_control`. This branch is the ONLY one that can
          // emit it: the OpenAI chat-completions and Responses branches above
          // build their bodies independently and never reach this code, so the
          // Azure / OpenAI / Codex / OpenRouter wires are structurally incapable
          // of receiving an Anthropic-shaped field.
          const cacheEnabled =
            features.promptCache && providerSupportsPromptCache(this.provider);

          for (const index of cacheEnabled
            ? planMessageBreakpoints(apiMessages, MESSAGE_CACHE_BREAKPOINTS)
            : []) {
            // `cache_control` would mutate a replayed assistant turn and violate
            // Anthropic's "echo exactly as received" signature contract. Keep the
            // stable system breakpoint and other message breakpoints; skip only
            // the opaque replayed turn.
            if (replayedRawMessageIndexes.has(index)) continue;
            // Mark the message's LAST block so the cached prefix covers it whole.
            // Breakpoints are recomputed from the current array on every call and
            // never carried across turns — which is exactly what makes recovery
            // from `native-loop`'s compaction automatic: compaction rewrites the
            // transcript and voids these entries, and the next call simply plans
            // fresh breakpoints over the rewritten history.
            const blocks = apiMessages[index]?.content;
            const lastBlock = blocks?.length ? blocks[blocks.length - 1] : undefined;
            if (blocks && lastBlock) blocks[blocks.length - 1] = withCacheControl(lastBlock);
          }

          const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: NATIVE_COMPLETION_TOKEN_LIMIT,
            ...this.anthropicThinkingField(),
            // The remaining breakpoint goes on the system prompt. Because the
            // wire renders `tools` → `system` → `messages`, one marker here
            // caches the tool schemas AND the system prompt together — the
            // largest, most static span in the request, and the one that never
            // changes for the lifetime of an agent session. Sent as a block array
            // (the only shape that accepts `cache_control`) when caching is on,
            // and left as a plain string otherwise so non-caching providers see a
            // byte-identical body to before this change.
            system: cacheEnabled
              ? [withCacheControl({ type: "text", text: system })]
              : system,
            messages: apiMessages,
          };

          if (tools.length > 0) {
            body.tools = tools;
          }

          res = await this.postWithRetry(
            () => JSON.stringify({ ...body, model: this.model }),
            call.signal,
            call,
          );
        } else {
          throw new Error(`executeNative: provider ${this.provider} is not mapped to a wire`);
        }
      } while (!res);

      // Keep the abort timer ARMED through the body read. `fetch()` resolves as
      // soon as the response HEADERS arrive; the body is drained by `res.text()`.
      // If a provider (or a CDN in front of it) flushes a 200 status line early
      // and then trickles/stalls the body, clearing the timer here would leave
      // `res.text()` unbounded — a single call could hang the whole craft loop
      // forever. z.ai/GLM and Anthropic both buffer non-streaming responses and
      // send headers+body together at the end (TTFB≈TOTAL, verified 2026-07-08),
      // so in practice this changes nothing for them; it only closes the latent
      // "timer cleared too early" gap. Cleared right after the body is in hand.
      const responseText = await res.text();

      clearTimeout(timer);

      if (!res.ok) {
        return {
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          durationMs: Date.now() - start,
          error: `${this.providerLabel} API error ${res.status}: ${responseText.slice(0, 500)}`,
        };
      }

      const parsedResponse = JSON.parse(responseText);
      this.observeAccessProgram(parsedResponse);
      // Code Assist wraps the generateContent response in `{ response }`; unwrap
      // it so the shared Google parser (below) sees the native candidates shape.
      const json = this.provider === "cline" ? clineChatResponse(parsedResponse)
        : this.isGeminiCodeAssist ? (parsedResponse.response ?? parsedResponse) : parsedResponse;
      appendNativeTrace({
        kind: "native-response",
        provider: this.providerLabel,
        wireApi: this.wireApi,
        usage: json.usage ?? null,
        outputPreview: Array.isArray(json.output)
          ? json.output.slice(0, 10).map((item: Record<string, unknown>) => ({
              type: item.type,
              summary: item.summary,
              content: item.content,
              name: item.name,
            }))
          : null,
        topLevelKeys: Object.keys(json),
      });

      // Parse response into unified content blocks
      let content: NativeContentBlock[];
      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
      let usage: NativeRuntimeResult["usage"];
      // Set on the Responses path only — the wire formats that have no
      // replayable item array leave it undefined and keep today's behaviour.
      let providerRaw: NativeRuntimeResult["providerRaw"];

      if (this.isOpenAICompat && this.wireApi === "chat_completions") {
        const choice = json.choices?.[0];
        const msg = choice?.message;
        content = [];

        // Handle reasoning models that return content: null with reasoning field
        const textContent = msg?.content ?? msg?.reasoning;
        if (textContent) {
          content.push({ type: "text", text: textContent });
        }
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: safeParseJson(tc.function.arguments),
            });
          }
        }

        const finishReason = choice?.finish_reason;
        stopReason =
          finishReason === "tool_calls" || finishReason === "function_call"
            ? "tool_use"
            : finishReason === "length"
              ? "max_tokens"
              : "end_turn";

        if (json.usage) {
          usage = readChatUsage(json.usage);
        }
      } else if (this.isGoogleWire || this.isGeminiCodeAssist) {
        const candidate = json.candidates?.[0];
        const rawParts = Array.isArray(candidate?.content?.parts)
          ? candidate.content.parts as Array<Record<string, unknown>>
          : [];
        content = [];
        if (rawParts.length > 0) {
          providerRaw = {
            provider: this.provider,
            model: this.model,
            wireApi: this.wireApi,
            output: rawParts,
          };
        }
        for (const part of rawParts) {
          if (typeof part.text === "string") {
            content.push({ type: "text", text: part.text });
            continue;
          }
          const call =
            part.functionCall && typeof part.functionCall === "object"
              ? part.functionCall as Record<string, unknown>
              : undefined;
          if (call && typeof call.name === "string") {
            content.push({
              type: "tool_use",
              id: typeof call.id === "string" ? call.id : `google-call-${++googleFunctionCallSequence}`,
              name: call.name,
              input:
                call.args && typeof call.args === "object" && !Array.isArray(call.args)
                  ? call.args as Record<string, unknown>
                  : {},
            });
          }
        }
        const finishReason = String(candidate?.finishReason ?? "").toUpperCase();
        stopReason = content.some((block) => block.type === "tool_use")
          ? "tool_use"
          : finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : "end_turn";
        if (json.usageMetadata) {
          usage = readGoogleUsage(json.usageMetadata);
        }
      } else {
        // Anthropic format (also serves the z-ai/GLM and kimi/Moonshot
        // providers — see `isAnthropicWire`).
        const rawBlocks = (json.content ?? []) as Array<Record<string, unknown>>;
        const hasAnthropicThinking = rawBlocks.some(
          (block) => block.type === "thinking" || block.type === "redacted_thinking",
        );
        // Claude signs its thinking blocks and requires the complete assistant
        // content array to return untouched on the next turn. Keep that opaque
        // sidecar only for the real Anthropic provider; GLM's documented
        // contract does not require echoing its thinking blocks.
        if (
          features.retainedReasoning
          && this.provider === "anthropic"
          && hasAnthropicThinking
        ) {
          providerRaw = {
            provider: this.provider,
            model: this.model,
            wireApi: this.wireApi,
            output: rawBlocks,
          };
        }
        // Surface visible thinking to the UI, then keep it out of
        // NativeContentBlock. Claude's opaque raw assistant turn stays in
        // providerRaw; GLM's thinking is intentionally not retained.
        if (callbacks?.onThinking) {
          const thinkingText = rawBlocks
            .filter((b) => b.type === "thinking")
            .map((b) => (typeof b.thinking === "string" ? b.thinking : ""))
            .join("")
            .trim();
          if (thinkingText) callbacks.onThinking(thinkingText);
        }
        content = rawBlocks
          .filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking")
          .map((block: Record<string, unknown>) => {
            if (block.type === "text") {
              return { type: "text", text: block.text as string };
            }
            if (block.type === "tool_use") {
              return {
                type: "tool_use",
                id: block.id as string,
                name: block.name as string,
                input: block.input as Record<string, unknown>,
              };
            }
            return { type: "text", text: JSON.stringify(block) };
          });

        stopReason = json.stop_reason === "tool_use" ? "tool_use" as const
          : json.stop_reason === "max_tokens" ? "max_tokens" as const
          : "end_turn" as const;

        // `readCacheUsage` re-adds the cached spans that Anthropic subtracts
        // out of `input_tokens`, so `inputTokens` keeps meaning "total prompt
        // tokens" whether or not caching is active — see prompt-cache.ts.
        if (json.usage) {
          usage = readCacheUsage(json.usage);
          this.logCacheUsage(usage);
        }
      }

      // Live-usage snapshot for per-turn accounting. The streaming Responses
      // path already reports through `callbacks.onUsage` as events arrive; the
      // non-streaming wires (Anthropic / chat-completions) only carried usage
      // on the RETURN value, which left callback-only consumers (craft-scan)
      // at zero. Consumers that also read `result.usage` (native-loop,
      // turn-engine) treat this callback as display-only, so there is no
      // double count.
      if (usage) callbacks?.onUsage?.(usage);

      return {
        content,
        stopReason,
        usage,
        durationMs: Date.now() - start,
        ...(providerRaw ? { providerRaw } : {}),
      };
    } catch (err) {
      clearTimeout(timer);
      // Local admission failures prove no inference POST even if cancellation
      // arrived during the catalog read; preserve that accounting authority.
      if (err instanceof Error && isLocalAdmissionFailure(err.message)) return {
        content: [], stopReason: "error", durationMs: Date.now() - start, error: err.message,
        ...(call.operatorAborted() ? { cancelled: true } : {}),
      };
      // Operator cancellation, checked BEFORE the timeout classification
      // below: an aborted `fetch` and an aborted stream read both reject with
      // an anonymous AbortError whose message contains "abort", so without
      // this the operator's Esc would be reported as "API request timed out".
      // `operatorAborted()` is the authority (not the raw signal state), so a
      // timeout that merely happened to be followed by an abort is still a
      // timeout.
      if (err instanceof OperatorAbortError || call.operatorAborted()) {
        return this.cancelledResult(start);
      }
      if (err instanceof QuotaExhaustedError) {
        // Plan-quota exhaustion: fail fast with the distinct, greppable
        // message (carries usage_limit_reached + resets_at) — never retried.
        return {
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          durationMs: Date.now() - start,
          error: err.message,
        };
      }
      let msg = err instanceof Error ? err.message : String(err);
      const transport = classifyTransportFailure(err);
      if (["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "CONNECTION_CLOSED"].includes(transport.code)
          && !/automatic replay (?:is )?disabled/i.test(msg)) msg = unknownTransportOutcome(this.providerLabel, transport);
      const unknownOutcome = /automatic replay (?:is )?disabled|outcome.{0,30}unknown/i.test(msg);
      // A transport may sanitize AbortError into a generic cancellation message.
      // Operator-first cancellation was handled above; our timer remains authoritative.
      const timedOut = controller.signal.aborted || msg.includes("abort") || msg.includes("timeout");
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
        error: timedOut
          ? `${this.providerLabel} API request timed out${unknownOutcome ? "; request outcome may be unknown. Automatic replay is disabled" : ""}`
          : `${this.providerLabel} API error: ${msg}`,
      };
    } finally {
      // Drop the listeners this call installed on the caller's (session-long)
      // operator signal. A no-op when no operator signal was passed.
      call.dispose();
    }
  }

  private async consumeResponsesStream(
    res: Response,
    start: number,
    callbacks?: NativeStreamCallbacks,
    opts?: { idleTimeoutMs?: number; eventIdleTimeoutMs?: number; abort?: CallAbort },
  ): Promise<NativeRuntimeResult> {
    const reader = res.body?.getReader();
    if (!reader) {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error: `${this.providerLabel} API error: missing response body`,
      };
    }

    let cancellationRequested = false;
    const cancelReader = () => {
      if (cancellationRequested) return;
      cancellationRequested = true;
      // A proxy may never acknowledge teardown. It must not delay a known
      // terminal outcome, operator cancellation, or the idle bound.
      try { void reader.cancel().catch(() => { /* best-effort */ }); }
      catch { /* best-effort */ }
    };

    // Idle watchdog on EVERY read — see llmStreamIdleTimeoutMs for why. The
    // overall request timer stays armed through this stream; the watchdog adds
    // a tighter bound for a silent stream between otherwise-valid SSE events.
    const idleTimeoutMs = opts?.idleTimeoutMs ?? llmStreamIdleTimeoutMs();
    // EVENT-level bound (keep-alive-proof) — see llmStreamEventIdleTimeoutMs.
    // `lastEventAt` moves ONLY when a real `data:` payload arrives (the parse
    // loop below); comment keep-alives / whitespace heartbeats never touch it,
    // so a server hold disguised by CDN keep-alives still fails as a stall.
    const eventIdleTimeoutMs = opts?.eventIdleTimeoutMs ?? llmStreamEventIdleTimeoutMs();
    let lastEventAt = Date.now();
    // The OPERATOR signal only — never the composed one. Racing the composed
    // signal here would convert a timeout abort into a cancellation and break
    // the "total request timeout applies even while the stream keeps yielding"
    // contract the watchdog tests pin.
    const operatorSignal = opts?.abort?.operator;
    let stalled = false;
    // Which bound fired — only for the diagnostic/error wording.
    let stallIdleMs = idleTimeoutMs;
    const readBounded = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      let timer: NodeJS.Timeout | undefined;
      let eventTimer: NodeJS.Timeout | undefined;
      // Undefined unless an operator signal exists, so the racer array below
      // stays exactly the two entries it has always had for every other call.
      const detach = operatorSignal ? new AbortController() : undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              stalled = true;
              stallIdleMs = idleTimeoutMs;
              reject(new Error("stream stalled"));
            }, idleTimeoutMs);
          }),
          // Event-level racer: fires when no MEANINGFUL SSE event has arrived
          // for `eventIdleTimeoutMs`, even if keep-alive bytes keep resetting
          // the byte-level timer above. Recomputed per read, so an event that
          // landed while the previous chunk was being parsed re-arms it.
          new Promise<never>((_resolve, reject) => {
            const remainingMs = eventIdleTimeoutMs - (Date.now() - lastEventAt);
            eventTimer = setTimeout(() => {
              stalled = true;
              stallIdleMs = eventIdleTimeoutMs;
              reject(new Error("stream stalled"));
            }, Math.max(remainingMs, 0));
          }),
          // A real aborted `fetch` also errors the body stream, so `read()`
          // would reject on its own — but only for a live socket. This racer
          // is what makes cancellation immediate and unconditional, including
          // for a body that is buffered, mocked, or already fully delivered.
          ...(operatorSignal && detach
            ? [
                new Promise<never>((_resolve, reject) => {
                  const abortError = () => opts?.abort?.operatorAborted()
                    ? new OperatorAbortError()
                    : new DOMException("Request deadline aborted the stream", "AbortError");
                  if (operatorSignal.aborted) {
                    reject(abortError());
                    return;
                  }
                  operatorSignal.addEventListener(
                    "abort",
                    () => reject(abortError()),
                    { once: true, signal: detach.signal },
                  );
                }),
              ]
            : []),
        ]);
      } finally {
        clearTimeout(timer);
        clearTimeout(eventTimer);
        detach?.abort();
      }
    };

    const decoder = new TextDecoder();
    let buffer = "";
    let trailingCR = false;
    let receivedBytes = 0;
    let malformedEvents = 0;
    const eventTypes = new Set<string>();
    // Only bounded protocol identifiers enter failure diagnostics, never the
    // provider's free-form message, request contents or account metadata.
    const identifier = (value: unknown): string | null =>
      typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(value) ? value : null;
    let completedResponse: Record<string, unknown> | null = null;
    let outputCapResponse: Record<string, unknown> | undefined;
    let assistantText = "";
    const pendingFunctionCalls = new Set<string>();
    let streamFailure: Record<string, string | null> | undefined;
    let responseUsage: NativeRuntimeResult["usage"];
    // The ChatGPT Codex backend's `response.completed` payload has NO
    // `output[]` array — it's just `{response: {id, usage, end_turn}}`.
    // Function calls + assistant messages flow exclusively through
    // `response.output_item.done` events during the stream. We collect
    // them here as a fallback the final-output extraction can fall back
    // on when `completedResponse.output` is absent. The public OpenAI
    // Responses API still populates `output` so this is harmless there.
    const streamedOutputItems: Array<Record<string, unknown>> = [];
    let thinkingText = "";
    let lastThinkingEmit = 0;
    let lastThinkingLength = 0;

    const emitThinking = (force = false) => {
      if (!callbacks?.onThinking || !thinkingText.trim()) return;
      if (force && lastThinkingEmit > 0 && lastThinkingLength === thinkingText.length) return;
      const now = Date.now();
      const nextChars = thinkingText.length - lastThinkingLength;
      const firstEmit = lastThinkingLength === 0;
      if (!force) {
        if (firstEmit && thinkingText.length < 96) return;
        if (nextChars < 96 && now - lastThinkingEmit < 250) return;
      }
      lastThinkingEmit = now;
      lastThinkingLength = thinkingText.length;
      callbacks.onThinking(thinkingText);
    };

    responses: while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readBounded();
      } catch (err) {
        if (err instanceof OperatorAbortError || opts?.abort?.operatorAborted()) {
          // Release the socket, then let executeNative's catch turn this into
          // the cancelled result. NOT a stall and NOT a timeout: no watchdog
          // diagnostic, no transient-class error the agent loop would retry.
          cancelReader();
          throw err instanceof OperatorAbortError ? err : new OperatorAbortError();
        }
        if (stalled) {
          // Release the held socket best-effort, then surface the stall as a
          // transient-class error (the agent loop's bounded retry applies; a
          // persistent server hold fails loudly via errorExit, never hangs).
          cancelReader();
          const secs = Math.round(stallIdleMs / 1000);
          diag.warn(
            "stream_stalled",
            `${this.providerLabel} stream stalled — no SSE events for ${secs}s (server hold; aborting call)`,
            {
              provider: this.providerLabel,
              idle_timeout_ms: stallIdleMs,
              idle_timeout_s: secs,
            },
          );
          return {
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            durationMs: Date.now() - start,
            error: `${this.providerLabel} stream stalled — no SSE events for ${secs}s (server accepted but held the stream; transient)`,
          };
        }
        cancelReader();
        throw err;
      }
      const { done, value } = chunk;
      if (done) {
        // SSE does not dispatch an unterminated final frame. Flush UTF-8 only
        // so diagnostics account for the remaining bytes without inventing one.
        buffer += decoder.decode();
        break;
      }
      receivedBytes += value.byteLength;
      let decoded = decoder.decode(value, { stream: true });
      if (decoded) {
        // SSE accepts LF, CRLF and CR, including CRLF split across reads.
        if (trailingCR && decoded.startsWith("\n")) decoded = decoded.slice(1);
        trailingCR = decoded.endsWith("\r");
        buffer += decoded.replace(/\r\n?/g, "\n");
      }

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawChunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        const payload = rawChunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!payload || payload === "[DONE]") continue;
        // A real `data:` payload (keep-alive comments / whitespace heartbeats
        // never reach here — they filter out above) re-arms the EVENT-level
        // watchdog; the byte-level one re-arms on any read.
        lastEventAt = Date.now();

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload) as Record<string, unknown>;
          if (!event || typeof event !== "object" || Array.isArray(event)) {
            malformedEvents++;
            continue;
          }
        } catch {
          malformedEvents++;
          continue;
        }

        const type = String(event.type ?? "");
        if (eventTypes.size < 32) eventTypes.add(identifier(type) ?? "unrecognized");
        const terminal = type === "response.completed" ||
          (this.provider === "openrouter" && type === "response.done");
        if (completedResponse && (
          type === "response.output_text.delta" || type === "response.content_part.delta" ||
          type === "response.output_item.added" || type === "response.output_item.done" ||
          type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary_text.done"
        )) {
          // Validate already-buffered contradictions, but never assemble new
          // output or invoke callbacks after the response's terminal boundary.
          streamFailure = { event: type, status: null, code: "output_after_completion", errorType: null, reason: null };
          break responses;
        }
        if (terminal || type === "response.failed" || type === "response.incomplete" || type === "error") {
          const response = event.response && typeof event.response === "object" && !Array.isArray(event.response)
            ? event.response as Record<string, unknown> : undefined;
          this.observeAccessProgram(response);
          const usage = readResponsesUsage(response?.usage);
          if (usage) {
            // A failed response can still report consumed tokens. Preserve them
            // independently of whether any output is safe to dispatch.
            responseUsage = usage;
            callbacks?.onUsage?.(responseUsage);
          }
          const incomplete = response?.incomplete_details as Record<string, unknown> | undefined;
          if (type === "response.incomplete" && response?.status === "incomplete" &&
              incomplete?.reason === "max_output_tokens" && response.error == null &&
              event.error == null && event.code == null && !completedResponse && malformedEvents === 0) {
            outputCapResponse = response;
            break responses;
          }
          if (!terminal || !response || response.error != null ||
              ((type === "response.done" || response.status !== undefined) && response.status !== "completed")) {
            const error = (response?.error ?? event.error) as Record<string, unknown> | undefined;
            streamFailure = {
              event: type,
              status: identifier(response?.status),
              code: identifier(error?.code ?? event.code),
              errorType: identifier(error?.type),
              reason: identifier(incomplete?.reason),
            };
            // A terminal rejection is final even if a later frame claims
            // success. Do not wait for EOF or allow buffered tools to escape.
            break responses;
          }
          completedResponse = response;
          continue;
        }
        if (
          type === "response.output_text.delta" ||
          (this.provider === "openrouter" && type === "response.content_part.delta")
        ) {
          // Retain visible observations even when the output cap prevents an
          // output_item.done/final output array. The callback is still a delta.
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta) {
            assistantText += delta;
            callbacks?.onDelta?.("assistant_response", delta);
          }
          continue;
        }

        if (type === "response.reasoning_summary_text.delta") {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta) {
            thinkingText += delta;
            // Forward the raw fragment to the cloud-side delta hook BEFORE
            // running the local thinking-emit heuristic — the cloud needs
            // the live stream, not the heuristic-throttled snapshots.
            callbacks?.onDelta?.("reasoning", delta);
            emitThinking(false);
          }
          continue;
        }

        if (type === "response.reasoning_summary_text.done") {
          const text = typeof event.text === "string"
            ? event.text
            : typeof event.part === "object" && event.part && typeof (event.part as Record<string, unknown>).text === "string"
              ? String((event.part as Record<string, unknown>).text)
              : "";
          if (text.trim()) {
            thinkingText = text;
            emitThinking(true);
          }
          continue;
        }

        if (type === "response.output_item.added") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            pendingFunctionCalls.add(String(item.id ?? item.call_id ?? event.output_index ?? pendingFunctionCalls.size));
          }
          continue;
        }

        if (type === "response.output_item.done") {
          // Codex backend (and recent public Responses API streams) emit
          // each output item — including function_call items — through
          // this event. The terminal `response.completed` payload has no
          // `output[]` on the Codex backend, so without capturing items
          // here every tool call gets discarded and the agent loop never
          // sees a tool_use block. Tested against
          // chatgpt.com/backend-api/codex/responses with gpt-5.5.
          const item = event.item as Record<string, unknown> | undefined;
          if (item && typeof item.type === "string") {
            if (item.type === "function_call") pendingFunctionCalls.add(String(item.id ?? item.call_id ?? event.output_index ?? pendingFunctionCalls.size));
            streamedOutputItems.push(item);
          }
          continue;
        }

      }
      // Drain complete frames already in this read so rejection/malformed
      // guards still apply. Completion never requires another read or HTTP EOF.
      if (completedResponse) break;
    }

    if (completedResponse || outputCapResponse || streamFailure) cancelReader();
    emitThinking(true);
    if (!outputCapResponse && opts?.abort?.operatorAborted()) {
      cancelReader();
      return { ...this.cancelledResult(start), ...(responseUsage ? { usage: responseUsage } : {}) };
    }
    if (opts?.abort?.signal.aborted && !opts.abort.operatorAborted()) {
      cancelReader();
      throw new DOMException("Request deadline aborted the stream", "AbortError");
    }

    if (outputCapResponse) {
      // Never replay opaque reasoning or dispatch ANY call from an incomplete
      // response, even when an individual item claimed to be done.
      cancelReader();
      const finalOutput = Array.isArray(outputCapResponse.output)
        ? outputCapResponse.output as Array<Record<string, unknown>> : [];
      const output = finalOutput.length > 0 ? finalOutput : streamedOutputItems;
      let finalText = "";
      for (const item of output) {
        if (item.type === "function_call") pendingFunctionCalls.add(String(item.id ?? item.call_id ?? pendingFunctionCalls.size));
        if (!Array.isArray(item.content)) continue;
        for (const block of item.content as Array<Record<string, unknown>>) {
          if (block.type === "output_text" && typeof block.text === "string") finalText += block.text;
        }
      }
      // Deltas are the observations already shown to the operator. Prefer the
      // final snapshot only when it extends them; don't duplicate either copy.
      const text = finalText.startsWith(assistantText) ? finalText : assistantText || finalText;
      if (operatorSignal?.aborted) {
        return { ...this.cancelledResult(start), content: [{ type: "text", text }], usage: responseUsage };
      }
      const checkpoint = {
        reason: "max_output_tokens" as const,
        ...(identifier(outputCapResponse.id) ? { responseId: String(outputCapResponse.id) } : {}),
        discardedToolCalls: pendingFunctionCalls.size,
      };
      appendNativeTrace({ kind: "native-response-checkpoint", provider: this.providerLabel,
        wireApi: this.wireApi, checkpoint, usage: responseUsage ?? null });
      return { content: [{ type: "text", text }], stopReason: "max_tokens", checkpoint,
        usage: responseUsage, durationMs: Date.now() - start };
    }

    if (!completedResponse || streamFailure) {
      if (streamFailure) {
        // Teardown must not delay an already-known terminal rejection.
        cancelReader();
      }
      appendNativeTrace({
        kind: "native-response-stream-error",
        provider: this.providerLabel,
        wireApi: this.wireApi,
        httpStatus: res.status,
        eventStreamContentType: /^text\/event-stream(?:\s*;|$)/i.test(res.headers.get("content-type") ?? ""),
        terminalFailure: streamFailure ?? null,
        eventTypes: [...eventTypes],
        receivedBytes,
        malformedEvents,
        trailingCharacters: buffer.length,
        usage: responseUsage ?? null,
      });
      return {
        content: thinkingText ? [{ type: "text", text: thinkingText }] : [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        ...(responseUsage ? { usage: responseUsage } : {}),
        error: `${this.providerLabel} API error: ${streamFailure
          ? `Responses terminal failure ${JSON.stringify(streamFailure)}`
          : `stream completed without final response (HTTP ${res.status}; events=${[...eventTypes].join(",") || "none"}; malformed=${malformedEvents}; trailing=${buffer.length})`}`,
      };
    }

    appendNativeTrace({
      kind: "native-response-stream",
      provider: this.providerLabel,
      wireApi: this.wireApi,
      usage: completedResponse.usage ?? null,
      outputPreview: Array.isArray(completedResponse.output)
        ? (completedResponse.output as Array<Record<string, unknown>>).slice(0, 10).map((item) => ({
            type: item.type,
            summary: item.summary,
            content: item.content,
            name: item.name,
          }))
        : null,
      streamedItems: streamedOutputItems.slice(0, 10).map((item) => ({
        type: item.type,
        name: item.name,
        call_id: item.call_id,
        argumentsPreview:
          typeof item.arguments === "string"
            ? (item.arguments as string).slice(0, 200)
            : undefined,
      })),
      topLevelKeys: Object.keys(completedResponse),
    });

    // Codex backend's `response.completed.output` is an EMPTY array (`[]`,
    // not absent) because items are already delivered via streamed
    // `response.output_item.done` events. The `??` operator wouldn't fall
    // through on `[]` — we'd keep the empty array and silently drop every
    // streamed function_call. Use the authoritative final array when populated;
    // only Codex's absent/empty array falls back to output_item.done items.
    const completedOutput = Array.isArray(completedResponse.output)
      ? completedResponse.output as Array<Record<string, unknown>> : [];
    const outputItems = completedOutput.length > 0 ? completedOutput : streamedOutputItems;
    const content: NativeContentBlock[] = [];
    // Reasoning summaries are surfaced to the UI and then DROPPED — never
    // pushed into `content`. See the reasoning branch below.
    const reasoningSummaries: string[] = [];
    const callIds = new Set<string>();
    for (const item of outputItems) {
      if (item.type === "function_call") {
        const call = parseResponsesFunctionCall(item);
        if (!call || callIds.has(call.id) || malformedEvents > 0) {
          return {
            content: [{ type: "text", text: assistantText }],
            stopReason: "error", usage: responseUsage, durationMs: Date.now() - start,
            error: `${this.providerLabel} API error: Responses completed with an incomplete or malformed function call`,
          };
        }
        callIds.add(call.id);
        content.push(call);
        continue;
      }
      if (item.type === "reasoning") {
        // The summary is a lossy PARAPHRASE of reasoning we now return
        // properly: the raw item (with its `encrypted_content`) rides back on
        // `providerRaw` and is spliced verbatim into the next request. Pushing
        // the paraphrase into `content` too made it a permanent assistant text
        // block that the agent loop replays as `output_text` on every later
        // turn — S·T(T−1)/2 tokens over a T-turn run, at full input price
        // because the Responses path has no prompt caching.
        const summaryParts = Array.isArray(item.summary)
          ? item.summary
              .map((block: Record<string, unknown>) => typeof block.text === "string" ? block.text : "")
              .filter((text: string) => text.trim().length > 0)
          : [];
        const reasoningText = summaryParts.join("\n").trim();
        if (reasoningText) reasoningSummaries.push(reasoningText);
        continue;
      }
      for (const block of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
        if (block.type === "output_text") {
          content.push({ type: "text", text: String(block.text ?? "") });
        }
      }
    }

    // Some Responses backends omit message items after streaming their text.
    // Keep those observed bytes in canonical history, never as hidden reasoning.
    const observedTextFallback = !!assistantText && !content.some(block => block.type === "text");
    if (observedTextFallback) content.unshift({ type: "text", text: assistantText });

    // The summary normally reached the UI live through
    // `response.reasoning_summary_text.delta`, in which case `lastThinkingEmit`
    // is already set and emitting here would show the same text twice. This is
    // only the fallback for a stream that carried the reasoning item but no
    // summary events.
    if (lastThinkingEmit === 0 && reasoningSummaries.length > 0) {
      thinkingText = reasoningSummaries.join("\n");
      emitThinking(true);
    }

    // A reasoning-summary fallback can call onThinking after the earlier
    // stream guard. Operator cancellation still wins before publishing tools
    // or providerRaw, without losing usage already observed on the wire.
    if (opts?.abort?.operatorAborted()) {
      return { ...this.cancelledResult(start), ...(responseUsage ? { usage: responseUsage } : {}) };
    }
    if (opts?.abort?.signal.aborted) {
      throw new DOMException("Request deadline aborted the stream", "AbortError");
    }

    return {
      content,
      stopReason: content.some((item) => item.type === "tool_use") ? "tool_use" : "end_turn",
      usage: responseUsage,
      durationMs: Date.now() - start,
      // `outputItems` is the complete, correctly-ordered response array —
      // reasoning items with their `encrypted_content` still attached, each
      // immediately followed by the item it produced. Handing it back lets the
      // next turn replay it verbatim instead of re-deriving the reasoning.
      ...(!observedTextFallback && outputItems.length > 0
        ? {
            providerRaw: {
              provider: this.provider,
              model: this.model,
              wireApi: this.wireApi,
              output: outputItems,
            },
          }
        : {}),
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this.provider === "chatgpt-plan") return this.siwcConnection !== undefined;
    if (this.grantedProviderTransport || this.workbenchProviderProxy) return true;
    // Credential presence only; this does not promise provider readiness or funds.
    if (this.provider === "chatgpt-codex") {
      return this.codexAuthState !== undefined;
    }
    return !!this.apiKey;
  }
}
