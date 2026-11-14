import { diag } from "../../diagnostics/channel.js";
import { togetherBaseUrl, CODEX_API_ENDPOINT, DEEPSEEK_DEFAULT_BASE_URL, KIMI_DEFAULT_BASE_URL, OPENCODE_DEFAULT_BASE_URL, QWEN_DEFAULT_BASE_URL, XAI_DEFAULT_BASE_URL, ZAI_DEFAULT_BASE_URL, openAICompatibleWireApi, opencodeWireApiForModel, type ApiProvider, type WireApi } from "./provider-config.js";
import { readChatGptCodexAuthFile } from "./codex-auth.js";
import { parseCodexAzureConfig } from "./provider-config.js";

export interface FallbackEntry {
  provider: ApiProvider;
  model: string;
}

/**
 * Parse the `ZERO_LLM_FALLBACK` env var into an ordered chain. Returns
 * the empty array when the env var is absent, empty, or every entry is
 * malformed (logged to stderr as a warning).
 */
export function parseLlmFallbackChain(env: Readonly<NodeJS.ProcessEnv> = process.env): FallbackEntry[] {
  const raw = env["ZERO_LLM_FALLBACK"];
  if (!raw || raw.trim().length === 0) return [];
  const entries: FallbackEntry[] = [];
  const VALID_PROVIDERS: Record<string, true> = {
    openrouter: true, anthropic: true, openai: true, azure: true, deepseek: true,
    "chatgpt-codex": true, "z-ai": true, kimi: true, qwen: true, xai: true, opencode: true,
    together: true,
  };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 1 || colonIdx === trimmed.length - 1) {
      diag.warn(
        "fallback_chain_malformed_entry",
        `ZERO_LLM_FALLBACK: malformed entry "${trimmed}" (expected provider:model)`,
        { entry: trimmed, expected: "provider:model" },
      );
      continue;
    }
    const provider = trimmed.slice(0, colonIdx) as ApiProvider;
    const model = trimmed.slice(colonIdx + 1).trim();
    if (!VALID_PROVIDERS[provider]) {
      diag.warn(
        "fallback_chain_unknown_provider",
        `ZERO_LLM_FALLBACK: unknown provider "${provider}" in "${trimmed}"`,
        { entry: trimmed, provider },
      );
      continue;
    }
    if (!model) {
      diag.warn(
        "fallback_chain_empty_model",
        `ZERO_LLM_FALLBACK: empty model in "${trimmed}"`,
        { entry: trimmed, provider },
      );
      continue;
    }
    entries.push({ provider, model });
  }
  return entries;
}

export interface ApiProviderConnection {
  apiKey: string;
  baseUrl: string;
  wireApi: WireApi;
}

/**
 * Resolve a (provider, model) pair to the env-var-driven config fields a
 * runtime needs. Returns `undefined` when the provider's auth env var is
 * absent so the caller can skip that entry.
 */
export function resolveFailoverProvider(
  provider: ApiProvider,
  model: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  apiKey?: string,
): ApiProviderConnection | undefined {
  switch (provider) {
    case "deepseek": {
      const key = apiKey ?? env.DEEPSEEK_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL, wireApi: "responses" };
    }
    case "openrouter": {
      const key = apiKey ?? env.OPENROUTER_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: "https://openrouter.ai/api/v1", wireApi: openAICompatibleWireApi(env, "OPENROUTER_WIRE_API") };
    }
    case "azure": {
      const key = apiKey ?? env.AZURE_OPENAI_API_KEY;
      if (!key) return undefined;
      const azureConfig = parseCodexAzureConfig(env);
      const url = env.AZURE_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL ?? azureConfig.baseUrl;
      if (!url) return undefined;
      return { apiKey: key, baseUrl: url, wireApi: openAICompatibleWireApi(env, "AZURE_OPENAI_WIRE_API", azureConfig.wireApi) };
    }
    case "openai": {
      const key = apiKey ?? env.OPENAI_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", wireApi: openAICompatibleWireApi(env, "OPENAI_WIRE_API") };
    }
    case "anthropic": {
      const key = apiKey ?? env.ANTHROPIC_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", wireApi: "chat_completions" };
    }
    case "chatgpt-codex": {
      // Codex uses OAuth, not an api key — presence of refresh/access token = available.
      if (!env["ZERO_CHATGPT_ACCESS_TOKEN"] && !env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] && !readChatGptCodexAuthFile(env)) return undefined;
      return { apiKey: "", baseUrl: CODEX_API_ENDPOINT, wireApi: "responses" };
    }
    case "z-ai": {
      const key = apiKey ?? env.Z_AI_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.Z_AI_BASE_URL ?? ZAI_DEFAULT_BASE_URL, wireApi: "chat_completions" };
    }
    case "kimi": {
      const key = apiKey ?? env.KIMI_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.KIMI_BASE_URL ?? KIMI_DEFAULT_BASE_URL, wireApi: "chat_completions" };
    }
    case "qwen": {
      const key = apiKey ?? env.QWEN_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.QWEN_BASE_URL ?? QWEN_DEFAULT_BASE_URL, wireApi: "chat_completions" };
    }
    case "xai": {
      const key = apiKey ?? env.XAI_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.XAI_BASE_URL ?? XAI_DEFAULT_BASE_URL, wireApi: openAICompatibleWireApi(env, "XAI_WIRE_API") };
    }
    case "together": {
      const key = apiKey ?? env.TOGETHER_API_KEY;
      if (!key?.trim()) return undefined;
      return { apiKey: key, baseUrl: togetherBaseUrl(env), wireApi: "chat_completions" };
    }
    case "opencode": {
      const key = apiKey ?? env.OPENCODE_API_KEY;
      if (!key) return undefined;
      return { apiKey: key, baseUrl: env.OPENCODE_BASE_URL ?? OPENCODE_DEFAULT_BASE_URL, wireApi: opencodeWireApiForModel(model) };
    }
  }
}

// Reset the cached fallback chain. Test-only.
export function __resetFallbackChainForTests(): void {
  fallbackChainCache = undefined;
}

let fallbackChainCache: { raw: string | undefined; entries: FallbackEntry[] } | undefined;

export function getFallbackChain(env: Readonly<NodeJS.ProcessEnv>): FallbackEntry[] {
  const raw = env["ZERO_LLM_FALLBACK"];
  if (!fallbackChainCache || fallbackChainCache.raw !== raw) {
    fallbackChainCache = { raw, entries: parseLlmFallbackChain(env) };
  }
  return fallbackChainCache.entries;
}
