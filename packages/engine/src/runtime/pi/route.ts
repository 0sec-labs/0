/**
 * Provider/model/credential resolution for PiAiRuntime (API-key providers only).
 *
 * Reuses `detectProvider` so env precedence, ZERO_SELECTED_PROVIDER/FORCE
 * pins and explicit-apiKey rules stay byte-identical to LlmApiRuntime. The
 * result is then restricted to the Phase 1 provider set; everything that needs
 * OAuth, special headers or a bespoke wire is REFUSED (never silently routed).
 *
 * Subscription OAuth (pi-ai `oauth`, Anthropic/Codex/Copilot logins) is
 * deliberately NOT enabled: provider terms for third-party OAuth use are
 * unverified.
 */
import type { RuntimeConfig } from "../types.js";
import { resolveWorkbenchProviderProxy } from "../workbench-provider-proxy.js";
import { detectProvider } from "../llm-api/provider-detect.js";
import { normalizeModelForProvider, type ApiProvider } from "../llm-api/provider-config.js";

export type PiApi = "anthropic-messages" | "openai-responses" | "openai-completions" | "google-generative-ai";

export interface PiRoute {
  /** Our provider label (from detectProvider / config). */
  zeroProvider: string;
  /** pi provider id that owns the model: "anthropic" | "openai" | "openrouter" | "google" | "openai-compat". */
  piProvider: string;
  api: PiApi;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Human label used in error strings, e.g. "Anthropic". */
  label: string;
  /** Base URL exactly as detectProvider reported it; keeps connection identity hashes identical across runtimes. */
  rawBaseUrl: string;
  /** The connection's wire as detected (before per-model upgrades), so a model change can recompute the route. */
  connWireApi: string;
}

const LABELS: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", google: "Google", "openai-compat": "OpenAI-compatible",
};

export class PiRouteError extends Error {
  override readonly name = "PiRouteError";
}

/** Providers that need OAuth, bespoke headers or a non-standard wire; Phase 2+ or never. */
const UNSUPPORTED_IN_PHASE_1 = new Set<string>([
  "chatgpt-codex", "chatgpt-plan", "copilot", "cline", "azure", "opencode", "z-ai", "kimi", "qwen",
]);

export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-pro";

function envString(env: Readonly<NodeJS.ProcessEnv>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

export function resolvePiRoute(config: RuntimeConfig, env: Readonly<NodeJS.ProcessEnv>): PiRoute {
  if (config.providerTransport || config.siwcConnection) {
    throw new PiRouteError("pi-ai runtime does not support granted provider transports or ChatGPT plan connections");
  }
  if (config.cyberAccessProgram !== undefined) {
    throw new PiRouteError("pi-ai runtime does not support cyber access programs (OpenAI Responses account headers)");
  }
  if (resolveWorkbenchProviderProxy(env)) {
    // The workbench broker only relays chatgpt-codex (subscription OAuth), which pi-ai does not serve here.
    throw new PiRouteError("pi-ai runtime does not support the workbench provider proxy (chatgpt-codex relay)");
  }
  const requestedProvider = config.provider ?? (envString(env, "ZERO_SELECTED_PROVIDER") as ApiProvider | undefined);
  if (requestedProvider === "google") {
    // pi's `google` provider is the Gemini API (API key); our `google` provider
    // is Code Assist OAuth, which pi-ai does not cover.
    const apiKey = config.apiKey ?? envString(env, "GEMINI_API_KEY") ?? envString(env, "GOOGLE_API_KEY");
    if (!apiKey) throw new PiRouteError("Google (pi-ai) requires GEMINI_API_KEY or GOOGLE_API_KEY, or RuntimeConfig.apiKey");
    return buildPiRoute("google", { apiKey, baseUrl: envString(env, "GOOGLE_GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta", wireApi: "google_generate_content" },
      config.model ?? envString(env, "ZERO_MODEL") ?? DEFAULT_GOOGLE_MODEL);
  }
  const detected = detectProvider(config.apiKey, config.model ?? env["ZERO_MODEL"], env, config.provider);
  const provider = detected.provider;
  if (UNSUPPORTED_IN_PHASE_1.has(provider)) {
    throw new PiRouteError(`pi-ai runtime does not support provider "${provider}" yet; use the default runtime`);
  }
  if (provider === "google") {
    throw new PiRouteError("pi-ai runtime does not support Gemini Code Assist OAuth; set provider=google with GEMINI_API_KEY");
  }
  if (!detected.apiKey) {
    throw new PiRouteError(`No API key resolved for provider "${provider}"`);
  }
  const requested = config.model ?? env["ZERO_MODEL"];
  const model = normalizeModelForProvider(provider, requested ?? detected.defaultModel);
  return buildPiRoute(provider, { apiKey: detected.apiKey, baseUrl: detected.baseUrl, wireApi: detected.wireApi }, model);
}

/** Map a resolved provider connection to a pi route. Throws PiRouteError for providers pi-ai Phase 2 does not serve. */
export function buildPiRoute(provider: ApiProvider, conn: { apiKey: string; baseUrl: string; wireApi: string }, model: string): PiRoute {
  return { ...buildRouteInner(provider, conn, model), rawBaseUrl: conn.baseUrl, connWireApi: conn.wireApi };
}

function buildRouteInner(provider: ApiProvider, conn: { apiKey: string; baseUrl: string; wireApi: string }, model: string): Omit<PiRoute, "rawBaseUrl" | "connWireApi"> {
  if (UNSUPPORTED_IN_PHASE_1.has(provider)) {
    throw new PiRouteError(`pi-ai runtime does not support provider "${provider}"`);
  }
  if (provider === "google") {
    // Only the Gemini API-key surface; Code Assist (OAuth, cloudcode endpoint) stays on the legacy runtime.
    if (!conn.apiKey || /cloudcode-pa\.googleapis\.com/.test(conn.baseUrl)) throw new PiRouteError("pi-ai runtime does not support Gemini Code Assist OAuth");
    return { zeroProvider: "google", piProvider: "google", api: "google-generative-ai", baseUrl: conn.baseUrl, apiKey: conn.apiKey, model, label: LABELS.google! };
  }
  if (provider === "anthropic") {
    return { zeroProvider: provider, piProvider: "anthropic", api: "anthropic-messages", baseUrl: stripV1(conn.baseUrl), apiKey: conn.apiKey, model, label: LABELS.anthropic! };
  }
  if (provider === "openrouter") {
    return { zeroProvider: provider, piProvider: "openrouter", api: "openai-completions", baseUrl: conn.baseUrl, apiKey: conn.apiKey, model, label: LABELS.openrouter! };
  }
  // Same per-model upgrade LlmApiRuntime applies: these models reject function tools + reasoning on /chat/completions.
  const normalizedModel = model.toLowerCase();
  const upgradeToResponses = conn.wireApi === "chat_completions" && provider === "openai"
    && (normalizedModel === "gpt-5.6-luna" || /^gpt-(?:[6-9]|\d{2,})(?:[-.]|$)/.test(normalizedModel));
  const api: PiApi = conn.wireApi === "responses" || upgradeToResponses ? "openai-responses" : "openai-completions";
  if (provider === "openai") {
    // pi's built-in `openai` provider only speaks the Responses API; chat-completions routes use the generic provider.
    const canonical = api === "openai-responses" && /^https:\/\/api\.openai\.com\/v1\/?$/.test(conn.baseUrl);
    // A non-canonical base URL (proxy, Ollama, vLLM, LM Studio) is an
    // OpenAI-compatible endpoint, not OpenAI: use the generic provider.
    return canonical
      ? { zeroProvider: provider, piProvider: "openai", api, baseUrl: conn.baseUrl, apiKey: conn.apiKey, model, label: LABELS.openai! }
      : { zeroProvider: provider, piProvider: "openai-compat", api, baseUrl: conn.baseUrl, apiKey: conn.apiKey, model, label: LABELS["openai-compat"]! };
  }
  // deepseek / xai / together / others speaking chat-completions with a key.
  return { zeroProvider: provider, piProvider: "openai-compat", api: "openai-completions", baseUrl: conn.baseUrl, apiKey: conn.apiKey, model, label: LABELS["openai-compat"]! };
}

/** pi's Anthropic client appends `/v1/...` itself; detectProvider's base is the bare host. */
function stripV1(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

/** Recompute a route for a different model on the same connection (fork, reconfigure). */
export function routeForModel(route: PiRoute, model: string): PiRoute {
  if (route.piProvider === "google") return { ...route, model };
  return buildPiRoute(route.zeroProvider as ApiProvider, { apiKey: route.apiKey, baseUrl: route.rawBaseUrl, wireApi: route.connWireApi }, model);
}
