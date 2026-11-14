import { type RuntimeConfig } from "../types.js";
import { existsSync, readFileSync } from "node:fs";
import { resolveWorkbenchProviderProxy } from "../workbench-provider-proxy.js";
import { AZURE_FOUNDRY_DEPLOYMENT_IDS, TOGETHER_DEFAULT_MODEL, togetherBaseUrl, CLINE_DEFAULT_BASE_URL, CLINE_DEFAULT_MODEL, CODEX_API_ENDPOINT, CODEX_DEFAULT_MODEL, CODE_ASSIST_ENDPOINT, COPILOT_API_BASE, COPILOT_DEFAULT_MODEL, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL, GEMINI_DEFAULT_MODEL, KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL, OPENCODE_DEFAULT_BASE_URL, OPENCODE_DEFAULT_MODEL, QWEN_DEFAULT_BASE_URL, QWEN_DEFAULT_MODEL, QWEN_TOKEN_PLAN_DEEPSEEK_MODEL, XAI_DEFAULT_BASE_URL, XAI_DEFAULT_MODEL, ZAI_DEFAULT_BASE_URL, ZAI_DEFAULT_MODEL, openAICompatibleWireApi, opencodeWireApiForModel, type ApiProvider, type WireApi } from "./provider-config.js";
import { resolveFailoverProvider } from "./fallback.js";
import { parseCodexAzureConfig } from "./provider-config.js";
import { readChatGptCodexAuthFile, readChatGptCodexEnv } from "./codex-auth.js";

export interface ApiRuntimeDiagnostics {
  valid: boolean;
  provider: ApiProvider;
  providerLabel: string;
  reason?: "missing_key" | "invalid_config";
  fatalError?: string;
}

/**
 * Per-call model→provider routing. Maps a requested model id to its NATURAL
 * provider, returning it only when that provider's auth is present in env. This
 * is what lets a single process fan calls out across providers — e.g. a hunt
 * running with several `models` ([gpt-5.5, glm-5.2, claude-*]) routes each model
 * to its own provider+key simultaneously, instead of the global env-priority
 * picking one provider for the whole process. Returns undefined → fall back to
 * the env-priority chain (existing behaviour).
 */
export function providerForModel(model: string | undefined, env: Readonly<NodeJS.ProcessEnv>): ApiProvider | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  // Direct DeepSeek's stable V4.1 id and still-accepted V4 Flash API id.
  // Preserve the latter's precedence over the separately cased Azure deployment.
  if (model === DEEPSEEK_DEFAULT_MODEL || model === "deepseek-v4-flash") {
    return env.DEEPSEEK_API_KEY ? "deepseek" : undefined;
  }
  // Azure Foundry deployment ids must win when the worker injects a direct
  // DeepSeek failover key; otherwise env priority would send the Azure model
  // to the direct endpoint.
  if (AZURE_FOUNDRY_DEPLOYMENT_IDS[m]) {
    return env.AZURE_OPENAI_API_KEY ? "azure" : undefined;
  }
  // Alibaba Token Plan DeepSeek revision: qwen-served, exact id.
  if (m === QWEN_TOKEN_PLAN_DEEPSEEK_MODEL) {
    return env.QWEN_API_KEY ? "qwen" : undefined;
  }
  if (m.startsWith("cline/") || m.startsWith("cline-pass/")) return env.CLINE_API_KEY?.trim() ? "cline" : undefined;
  // Together is explicit-prefix only: its `<org>/<model>` ids would otherwise
  // be claimed by the qwen / z-ai / deepseek family matches below.
  if (m.startsWith("together/")) return env.TOGETHER_API_KEY?.trim() ? "together" : undefined;
  if (m.startsWith("openrouter/")) return env.OPENROUTER_API_KEY ? "openrouter" : undefined;
  // GLM / Z.ai.
  if (m.startsWith("glm-") || m.startsWith("z-ai/") || m.includes("glm")) {
    return env.Z_AI_API_KEY ? "z-ai" : undefined;
  }
  // Kimi K3 / Moonshot.
  if (m.startsWith("k3") || m.startsWith("kimi")) {
    return env.KIMI_API_KEY ? "kimi" : undefined;
  }
  // Qwen / Alibaba Model Studio.
  if (m.startsWith("qwen")) {
    return env.QWEN_API_KEY ? "qwen" : undefined;
  }
  // xAI Grok. Matches bare ids ("grok-4.6") and the vendor-prefixed form.
  if (m.startsWith("grok") || m.startsWith("xai/") || m.startsWith("x-ai/")) {
    return env.XAI_API_KEY ? "xai" : undefined;
  }
  // OpenCode Zen: vendor prefix + Zen-exclusive families (no native provider).
  if (/^(opencode\/|muse-spark|mimo|ling|big-pickle|nemotron|minimax)/.test(m)) {
    return env.OPENCODE_API_KEY ? "opencode" : undefined;
  }
  // GitHub Copilot: the `copilot/` prefix routes to Copilot regardless of the
  // underlying family (Copilot serves gpt-*/claude-*/gemini-*), so it must win
  // over the bare gpt-*/claude-* branches below.
  if (m.startsWith("copilot/")) {
    return env["ZERO_COPILOT_GITHUB_TOKEN"] ? "copilot" : undefined;
  }
  // Google Gemini Code Assist. Bare `gemini-*` ids (or the `google/` prefix)
  // route to the Code Assist backend when Google OAuth is present. This is
  // AFTER the opencode-prefix check above so `opencode/gemini-*` still rides the
  // OpenCode Zen gateway rather than Code Assist.
  if (m.startsWith("gemini") || m.startsWith("google/")) {
    return env["ZERO_GEMINI_ACCESS_TOKEN"] || env["ZERO_GEMINI_OAUTH_REFRESH_TOKEN"] ? "google" : undefined;
  }
  // OpenAI GPT / o-series → this client's signed-in Codex account, else OpenAI.
  if (/^gpt-|^o[1-4](?:[-_]|$)/.test(m)) {
    if (readChatGptCodexEnv(env) || readChatGptCodexAuthFile(env)) return "chatgpt-codex";
    if (env.OPENAI_API_KEY) return "openai";
    return undefined;
  }
  // Claude / Anthropic → direct anthropic key, else OpenRouter (anthropic/*).
  if (m.startsWith("claude") || m.startsWith("anthropic/") || m.includes("sonnet") || m.includes("opus") || m.includes("haiku")) {
    if (env.ANTHROPIC_API_KEY) return "anthropic";
    if (env.OPENROUTER_API_KEY) return "openrouter";
    return undefined;
  }
  return undefined;
}

export const DEFAULT_PROVIDER_MODELS: Record<ApiProvider, string | undefined> = {
  openrouter: DEFAULT_OPENROUTER_MODEL, anthropic: DEFAULT_ANTHROPIC_MODEL,
  openai: DEFAULT_OPENAI_MODEL, azure: undefined, deepseek: DEEPSEEK_DEFAULT_MODEL,
  "chatgpt-plan": undefined, "chatgpt-codex": CODEX_DEFAULT_MODEL, "z-ai": ZAI_DEFAULT_MODEL,
  kimi: KIMI_DEFAULT_MODEL, qwen: QWEN_DEFAULT_MODEL, xai: XAI_DEFAULT_MODEL,
  cline: CLINE_DEFAULT_MODEL, together: TOGETHER_DEFAULT_MODEL, opencode: OPENCODE_DEFAULT_MODEL, copilot: COPILOT_DEFAULT_MODEL,
  google: GEMINI_DEFAULT_MODEL,
};

/**
 * Sentinel `agentModels[role]` value (and the meaning of `RuntimeConfig.autoRoute`
 * for an unmapped role): let the orchestrator pick the subagent's model for this
 * role, bounded to what is actually reachable. Never a real model id — it must
 * never flow into a selected model — it only WIDENS the operator-approved fork
 * guard to also accept any accessible model (see `LlmApiRuntime.forkForSubagent`).
 */
export const AUTO_MODEL_SENTINEL = "auto";

/**
 * Explicit provider, API key, and reachable model choices win. Otherwise prefer
 * subscription credentials, then ambient BYOK keys.
 */
export function detectProvider(configApiKey: string | undefined, preferredModel: string | undefined, env: Readonly<NodeJS.ProcessEnv>, configProvider?: ApiProvider): {
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  wireApi: WireApi;
  reasoningEffort?: string;
} {
  const proxy = resolveWorkbenchProviderProxy(env);
  if (proxy) {
    if ([configProvider, env.ZERO_SELECTED_PROVIDER, env.ZERO_FORCE_PROVIDER].some(provider => provider && provider !== "chatgpt-codex")) {
      throw new Error("Workbench provider broker supports chatgpt-codex only; no fallback is permitted");
    }
    return { provider: "chatgpt-codex", apiKey: "", baseUrl: proxy.url, defaultModel: proxy.model, wireApi: "responses" };
  }
  if (configProvider !== undefined && !Object.hasOwn(DEFAULT_PROVIDER_MODELS, configProvider)) {
    throw new Error(`RuntimeConfig.provider is unsupported: ${configProvider}`);
  }

  // Cloud workers hand the selected provider to the sandbox explicitly. This
  // wins over ambient credential precedence: fallback credentials must never
  // become the primary merely because their key is also present. The older
  // FORCE variant remains for controlled benchmark manifests.
  const selectedProviderRaw = configProvider ?? env["ZERO_SELECTED_PROVIDER"]?.trim();
  const forcedProviderRaw = env["ZERO_FORCE_PROVIDER"]?.trim() || undefined;
  if (
    selectedProviderRaw &&
    forcedProviderRaw &&
    selectedProviderRaw !== forcedProviderRaw
  ) {
    throw new Error(
      `${configProvider !== undefined ? "RuntimeConfig.provider" : "ZERO_SELECTED_PROVIDER"} conflicts with ZERO_FORCE_PROVIDER`,
    );
  }
  // The worker pin chooses the primary scan provider. A hunt's refuter creates
  // a runtime with a different explicit model; honoring the primary pin there
  // would route that model through the wrong credential and defeat cross-family
  // refutation. ZERO_FORCE_PROVIDER remains an unconditional benchmark guard.
  const primaryModel = env["ZERO_MODEL"]?.trim();
  const selectedProviderApplies =
    configProvider !== undefined || !preferredModel || !primaryModel || preferredModel === primaryModel;
  const pinnedProviderRaw =
    forcedProviderRaw ??
    (selectedProviderApplies ? selectedProviderRaw : undefined);
  if (preferredModel && /^(?:cline\/|cline-pass\/)/i.test(preferredModel)) {
    if (pinnedProviderRaw && pinnedProviderRaw !== "cline") {
      throw new Error("Cline model IDs require the Cline provider; choose the Cline connection.");
    }
    if (configApiKey && !pinnedProviderRaw) {
      throw new Error("Cline model IDs with RuntimeConfig.apiKey require an explicit Cline provider.");
    }
    if (!configApiKey && !env.CLINE_API_KEY?.trim()) {
      throw new Error("Cline model requires CLINE_API_KEY credentials. Connect Cline in Connections.");
    }
  }
  if (preferredModel && /^together\//i.test(preferredModel)) {
    if (pinnedProviderRaw && pinnedProviderRaw !== "together") {
      throw new Error("Together model IDs require the Together provider; choose the Together connection.");
    }
    if (configApiKey && !pinnedProviderRaw) {
      throw new Error("Together model IDs with RuntimeConfig.apiKey require an explicit Together provider.");
    }
    if (!configApiKey && !env.TOGETHER_API_KEY?.trim()) {
      throw new Error("Together model requires TOGETHER_API_KEY credentials. Connect Together AI in Connections.");
    }
  }
  if (pinnedProviderRaw) {
    const source = pinnedProviderRaw === forcedProviderRaw
      ? "ZERO_FORCE_PROVIDER"
      : configProvider !== undefined ? "RuntimeConfig.provider" : "ZERO_SELECTED_PROVIDER";
    if (!Object.hasOwn(DEFAULT_PROVIDER_MODELS, pinnedProviderRaw)) {
      throw new Error(`${source} is unsupported: ${pinnedProviderRaw}`);
    }
    const provider = pinnedProviderRaw as ApiProvider;
    const model = preferredModel ?? env["ZERO_MODEL"] ??
      (provider === "azure" ? env.AZURE_OPENAI_MODEL ?? parseCodexAzureConfig(env).model : provider === "openai" ? env.OPENAI_MODEL : undefined) ??
      (configProvider !== undefined ? DEFAULT_PROVIDER_MODELS[provider] : undefined);
    if (model === undefined || model === "") {
      if (provider === "azure") throw new Error("Choose an Azure deployment model in Connections to finish setup.");
      throw new Error(`${source} requires an explicit model`);
    }
    if (configApiKey && provider === "chatgpt-codex") {
      throw new Error(`${source}=${provider} requires its own authentication, not RuntimeConfig.apiKey`);
    }
    const resolved = resolveFailoverProvider(provider, model, env, configApiKey);
    if (!resolved) {
      throw new Error(`${source}=${provider} has no configured credentials`);
    }
    return { provider, ...resolved, defaultModel: model };
  }
  // If an explicit API key is passed via config, try to guess the provider from the key prefix
  if (configApiKey) {
    if (configApiKey.startsWith("sk-or-")) {
      return {
        provider: "openrouter",
        apiKey: configApiKey,
        baseUrl: "https://openrouter.ai/api/v1",
        defaultModel: DEFAULT_OPENROUTER_MODEL,
        wireApi: openAICompatibleWireApi(env, "OPENROUTER_WIRE_API"),
      };
    }
    if (configApiKey.startsWith("sk-ant-")) {
      return {
        provider: "anthropic",
        apiKey: configApiKey,
        baseUrl: "https://api.anthropic.com",
        defaultModel: DEFAULT_ANTHROPIC_MODEL,
        wireApi: "chat_completions",
      };
    }
    // Assume OpenAI-compatible for other keys
    return {
      provider: "openai",
      apiKey: configApiKey,
      baseUrl: "https://api.openai.com/v1",
      defaultModel: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      wireApi: openAICompatibleWireApi(env, "OPENAI_WIRE_API"),
    };
  }

  // Per-call routing: if the requested model maps to a provider whose auth is
  // present, that provider wins over the global env priority — so one process
  // can fan calls across providers (gpt-5.5→codex, glm-5.2→z-ai, claude→anthropic).
  switch (providerForModel(preferredModel, env)) {
    case "deepseek":
      return { provider: "deepseek", apiKey: env.DEEPSEEK_API_KEY as string,
        baseUrl: env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
        defaultModel: DEEPSEEK_DEFAULT_MODEL, wireApi: "responses" };
    case "azure": {
      const azureKey = env.AZURE_OPENAI_API_KEY;
      if (!azureKey) break;
      const azureConfig = parseCodexAzureConfig(env);
      return {
        provider: "azure",
        apiKey: azureKey,
        baseUrl:
          env.AZURE_OPENAI_BASE_URL ??
          env.OPENAI_BASE_URL ??
          azureConfig.baseUrl ??
          "https://api.openai.com/v1",
        defaultModel:
          preferredModel ??
          env.AZURE_OPENAI_MODEL ??
          azureConfig.model ??
          DEFAULT_OPENAI_MODEL,
        wireApi: openAICompatibleWireApi(env, "AZURE_OPENAI_WIRE_API", azureConfig.wireApi),
        reasoningEffort: azureConfig.reasoningEffort,
      };
    }
    // z-ai (GLM) and kimi (Moonshot) ride the Anthropic Messages wire (routed by
    // LlmApiRuntime.isAnthropicWire — NOT by this `wireApi` field). The
    // "chat_completions" below is an inert default that is intentionally UNUSED
    // for these two providers; do NOT add them to isOpenAICompat.
    case "z-ai":
      return { provider: "z-ai", apiKey: env.Z_AI_API_KEY as string,
        baseUrl: env.Z_AI_BASE_URL ?? ZAI_DEFAULT_BASE_URL, defaultModel: ZAI_DEFAULT_MODEL, wireApi: "chat_completions" };
    case "kimi":
      return { provider: "kimi", apiKey: env.KIMI_API_KEY as string,
        baseUrl: env.KIMI_BASE_URL ?? KIMI_DEFAULT_BASE_URL, defaultModel: KIMI_DEFAULT_MODEL, wireApi: "chat_completions" };
    case "qwen":
      return { provider: "qwen", apiKey: env.QWEN_API_KEY as string,
        baseUrl: env.QWEN_BASE_URL ?? QWEN_DEFAULT_BASE_URL, defaultModel: QWEN_DEFAULT_MODEL, wireApi: "chat_completions" };
    case "xai":
      return { provider: "xai", apiKey: env.XAI_API_KEY as string,
        baseUrl: env.XAI_BASE_URL ?? XAI_DEFAULT_BASE_URL, defaultModel: XAI_DEFAULT_MODEL, wireApi: openAICompatibleWireApi(env, "XAI_WIRE_API") };
    case "cline":
      return { provider: "cline", apiKey: env.CLINE_API_KEY as string,
        baseUrl: env.CLINE_BASE_URL ?? CLINE_DEFAULT_BASE_URL, defaultModel: CLINE_DEFAULT_MODEL, wireApi: "chat_completions" };
    case "together":
      return { provider: "together", apiKey: env.TOGETHER_API_KEY as string,
        baseUrl: togetherBaseUrl(env), defaultModel: TOGETHER_DEFAULT_MODEL, wireApi: "chat_completions" };
    case "opencode":
      return { provider: "opencode", apiKey: env.OPENCODE_API_KEY as string,
        baseUrl: env.OPENCODE_BASE_URL ?? OPENCODE_DEFAULT_BASE_URL, defaultModel: OPENCODE_DEFAULT_MODEL, wireApi: opencodeWireApiForModel(preferredModel) };
    case "copilot":
      return { provider: "copilot", apiKey: env["ZERO_COPILOT_GITHUB_TOKEN"] as string,
        baseUrl: env.COPILOT_BASE_URL ?? COPILOT_API_BASE, defaultModel: preferredModel ?? COPILOT_DEFAULT_MODEL, wireApi: "chat_completions" };
    case "google":
      // OAuth Bearer, refreshed on demand — empty apiKey like chatgpt-codex.
      return { provider: "google", apiKey: "", baseUrl: CODE_ASSIST_ENDPOINT,
        defaultModel: preferredModel ?? GEMINI_DEFAULT_MODEL, wireApi: "google_generate_content" };
    case "chatgpt-codex":
      return { provider: "chatgpt-codex", apiKey: "", baseUrl: CODEX_API_ENDPOINT,
        defaultModel: env["ZERO_MODEL"] ?? CODEX_DEFAULT_MODEL, wireApi: "responses" };
    case "anthropic":
      return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY as string,
        baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", defaultModel: DEFAULT_ANTHROPIC_MODEL, wireApi: "chat_completions" };
    case "openrouter":
      return { provider: "openrouter", apiKey: env.OPENROUTER_API_KEY as string,
        baseUrl: "https://openrouter.ai/api/v1", defaultModel: DEFAULT_OPENROUTER_MODEL, wireApi: openAICompatibleWireApi(env, "OPENROUTER_WIRE_API") };
    case "openai":
      return { provider: "openai", apiKey: env.OPENAI_API_KEY as string,
        baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", defaultModel: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL, wireApi: openAICompatibleWireApi(env, "OPENAI_WIRE_API") };
    default:
      break; // fall through to env-priority detection
  }

  // Prefer ChatGPT subscription auth over API keys:
  //
  //   - ZERO_CHATGPT_ACCESS_TOKEN — pre-issued access token. The
  //     worker-controller refreshes once at dispatch time, persists the
  //     rotated refresh_token back to auth.json, and forwards just the
  //     access_token to each sandbox. This is the multi-sandbox path
  //     because it eliminates the OAuth refresh-token rotation race
  //     (every sandbox refreshing in parallel against a refresh_token
  //     that gets invalidated on first use).
  //
  //   - ZERO_CHATGPT_OAUTH_REFRESH_TOKEN — refresh token only. The
  //     in-process provider refreshes on demand. Suitable for local CLI
  //     use (one process at a time); not safe for parallel sandbox
  //     dispatch.
  //
  // Either env present → use the chatgpt-codex provider; we skip the
  // api-key providers entirely because the operator has explicitly told
  // us to use the subscription path.
  const chatGptAccess = env["ZERO_CHATGPT_ACCESS_TOKEN"];
  const chatGptRefresh = env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
  const chatGptAuthFile = !chatGptAccess && !chatGptRefresh
    ? readChatGptCodexAuthFile(env)
    : undefined;
  if (
    (chatGptAccess && chatGptAccess.length > 0) ||
    (chatGptRefresh && chatGptRefresh.length > 0) ||
    !!chatGptAuthFile
  ) {
    return {
      provider: "chatgpt-codex",
      // No api key — auth flows via OAuth bearer that's refreshed on
      // demand by getChatGptCodexAccessToken(). Empty string keeps the
      // existing apiKey-required diagnostics from firing (those check
      // for empty strings; we want "valid but bearer-not-key").
      apiKey: "",
      // baseUrl is informational only — the runtime hardcodes
      // CODEX_API_ENDPOINT for this provider.
      baseUrl: CODEX_API_ENDPOINT,
      defaultModel: env["ZERO_MODEL"] ?? CODEX_DEFAULT_MODEL,
      wireApi: "responses",
    };
  }

  // Direct DeepSeek is the first metered fallback after Codex.
  // Its native Responses API supports Flash 0731 tool calling.
  const deepseekKey = env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    return {
      provider: "deepseek",
      apiKey: deepseekKey,
      baseUrl: env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
      defaultModel: DEEPSEEK_DEFAULT_MODEL,
      wireApi: "responses",
    };
  }

  const openrouterKey = env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return {
      provider: "openrouter",
      apiKey: openrouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: DEFAULT_OPENROUTER_MODEL,
      wireApi: openAICompatibleWireApi(env, "OPENROUTER_WIRE_API"),
    };
  }

  const azureKey = env.AZURE_OPENAI_API_KEY;
  if (azureKey) {
    const azureConfig = parseCodexAzureConfig(env);
    return {
      provider: "azure",
      apiKey: azureKey,
      baseUrl: env.AZURE_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL ?? azureConfig.baseUrl ?? "https://api.openai.com/v1",
      defaultModel: env.AZURE_OPENAI_MODEL ?? azureConfig.model ?? DEFAULT_OPENAI_MODEL,
      wireApi: openAICompatibleWireApi(env, "AZURE_OPENAI_WIRE_API", azureConfig.wireApi),
      reasoningEffort: azureConfig.reasoningEffort,
    };
  }

  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      defaultModel: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      wireApi: openAICompatibleWireApi(env, "OPENAI_WIRE_API"),
    };
  }

  // Z.ai GLM and Moonshot Kimi are explicit alternatives. They are tried
  // before Anthropic so Anthropic remains the final provider fallback.
  //
  // Z.ai GLM — Anthropic-compatible wire. Rides the anthropic
  // header/url/parser paths (routed by LlmApiRuntime.isAnthropicWire). The
  // `wireApi` below is an inert default that is intentionally UNUSED for z-ai;
  // do NOT add z-ai to isOpenAICompat.
  const zaiKey = env.Z_AI_API_KEY;
  if (zaiKey) {
    return {
      provider: "z-ai",
      apiKey: zaiKey,
      baseUrl: env.Z_AI_BASE_URL ?? ZAI_DEFAULT_BASE_URL,
      defaultModel: ZAI_DEFAULT_MODEL,
      wireApi: "chat_completions",
    };
  }

  // Moonshot Kimi — Anthropic-compatible wire, same treatment as z-ai. Rides
  // the Anthropic wire (routed by LlmApiRuntime.isAnthropicWire); the `wireApi`
  // below is an inert default that is intentionally UNUSED for kimi — do NOT
  // add kimi to isOpenAICompat.
  const kimiKey = env.KIMI_API_KEY;
  if (kimiKey) {
    return {
      provider: "kimi",
      apiKey: kimiKey,
      baseUrl: env.KIMI_BASE_URL ?? KIMI_DEFAULT_BASE_URL,
      defaultModel: KIMI_DEFAULT_MODEL,
      wireApi: "chat_completions",
    };
  }

  // Alibaba Qwen — same explicit-opt-in treatment as z-ai/kimi, still
  // before the Anthropic final fallback.
  const qwenKey = env.QWEN_API_KEY;
  if (qwenKey) {
    return {
      provider: "qwen",
      apiKey: qwenKey,
      baseUrl: env.QWEN_BASE_URL ?? QWEN_DEFAULT_BASE_URL,
      defaultModel: QWEN_DEFAULT_MODEL,
      wireApi: "chat_completions",
    };
  }

  // xAI Grok — OpenAI-compatible wire, same explicit-opt-in treatment as
  // z-ai/kimi/qwen, still before the Anthropic final fallback.
  const xaiKey = env.XAI_API_KEY;
  if (xaiKey) {
    return {
      provider: "xai",
      apiKey: xaiKey,
      baseUrl: env.XAI_BASE_URL ?? XAI_DEFAULT_BASE_URL,
      defaultModel: XAI_DEFAULT_MODEL,
      wireApi: openAICompatibleWireApi(env, "XAI_WIRE_API"),
    };
  }

  // OpenCode Zen — multi-wire gateway selected per model (see
  // opencodeWireApiForModel), same explicit-opt-in treatment as z-ai/kimi/qwen/xai,
  // still before the Anthropic final fallback.
  const opencodeKey = env.OPENCODE_API_KEY;
  if (opencodeKey) {
    return {
      provider: "opencode",
      apiKey: opencodeKey,
      baseUrl: env.OPENCODE_BASE_URL ?? OPENCODE_DEFAULT_BASE_URL,
      defaultModel: OPENCODE_DEFAULT_MODEL,
      wireApi: opencodeWireApiForModel(preferredModel),
    };
  }

  if (env.CLINE_API_KEY?.trim()) {
    return { provider: "cline", apiKey: env.CLINE_API_KEY,
      baseUrl: env.CLINE_BASE_URL ?? CLINE_DEFAULT_BASE_URL,
      defaultModel: CLINE_DEFAULT_MODEL, wireApi: "chat_completions" };
  }

  const copilotToken = env["ZERO_COPILOT_GITHUB_TOKEN"];
  if (copilotToken) {
    return {
      provider: "copilot",
      apiKey: copilotToken,
      baseUrl: env.COPILOT_BASE_URL ?? COPILOT_API_BASE,
      defaultModel: preferredModel ?? COPILOT_DEFAULT_MODEL,
      wireApi: "chat_completions",
    };
  }

  const geminiAccess = env["ZERO_GEMINI_ACCESS_TOKEN"];
  const geminiRefresh = env["ZERO_GEMINI_OAUTH_REFRESH_TOKEN"];
  if ((geminiAccess && geminiAccess.length > 0) || (geminiRefresh && geminiRefresh.length > 0)) {
    return {
      provider: "google",
      apiKey: "",
      baseUrl: CODE_ASSIST_ENDPOINT,
      defaultModel: env["ZERO_MODEL"] ?? GEMINI_DEFAULT_MODEL,
      wireApi: "google_generate_content",
    };
  }

  // Anthropic API key — checked last among BYOK providers so explicit
  // selections (config, env override, model routing, Codex) win first.
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      provider: "anthropic",
      apiKey: anthropicKey,
      baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
      wireApi: "chat_completions",
    };
  }

  // Together AI — the very last ambient fallback, after Anthropic. It was added
  // after the other providers, so a shell that exports TOGETHER_API_KEY next to
  // an existing provider key must keep resolving to that provider; Together is
  // then reached through ZERO_SELECTED_PROVIDER=together, the Connections
  // picker, or an explicit `together/<model>` id.
  if (env.TOGETHER_API_KEY?.trim()) {
    return { provider: "together", apiKey: env.TOGETHER_API_KEY,
      baseUrl: togetherBaseUrl(env),
      defaultModel: TOGETHER_DEFAULT_MODEL, wireApi: "chat_completions" };
  }

  // No key found — default to Anthropic (will fail at runtime with helpful message)
  return {
    provider: "anthropic",
    apiKey: "",
    baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    wireApi: "chat_completions",
  };
}
