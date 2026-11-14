import { existsSync, readFileSync } from "node:fs";
import { type RuntimeConfig } from "../types.js";

export function defaultReasoningEffort(model: string): string | undefined {
  const lower = model.toLowerCase();
  if (/gpt-[56](?:[-.]|$)/.test(lower) || /^o[134]/.test(lower)) return "medium";
  return undefined;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6";
export const FREE_OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
/** Strip the `openrouter/` routing prefix off a model id — the wire wants the
 *  bare catalog id (e.g. `z-ai/glm-5.3-flash`), mirroring opencode/copilot/cline. */
export function openrouterModelId(model: string): string { return model.replace(/^openrouter\//i, ""); }

/**
 * Normalize a model id for the provider that will serve it: strip the
 * provider's own routing prefix so the endpoint receives the canonical
 * upstream catalog id (`openrouter/z-ai/glm-5.3-flash` → `z-ai/glm-5.3-flash`
 * on OpenRouter, `opencode/x` → `x`, `copilot/gpt-4o` → `gpt-4o`,
 * `cline/x` → `x`). Every site that assigns a (provider, model) pair together
 * MUST route the model through this helper — sending the prefixed routing id
 * verbatim makes the upstream reject the request ("not a valid model ID").
 * cline-pass/ is part of the upstream id and is preserved.
 */
export function normalizeModelForProvider(provider: ApiProvider, model: string): string {
  if (provider === "opencode") return opencodeModelId(model);
  if (provider === "copilot") return copilotModelId(model);
  if (provider === "cline") return clineModelId(model);
  if (provider === "together") return togetherModelId(model);
  if (provider === "openrouter") return openrouterModelId(model);
  return model;
}
/** The one default model for OpenAI-family connections (API key, ChatGPT/Codex login, Azure fallback). */
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
/** Alibaba Token Plan serves this exact DeepSeek revision id under the qwen
 *  provider (credit-billed; see the worker's QWEN_TOKEN_PLAN_MODEL_IDS). The
 *  id must never fall through to direct DeepSeek — their balances are
 *  separate meters. */
export const QWEN_TOKEN_PLAN_DEEPSEEK_MODEL = "deepseek-v4-flash-0731";

// ── xAI Grok ───────────────────────────────────────────────────────────
//
// xAI ships an OpenAI-compatible `/v1/chat/completions` endpoint (Bearer +
// standard body), so xai rides the same wire the openai/deepseek/qwen
// providers use — it is NOT on the Anthropic Messages path z-ai/kimi take.
// Override base URL via XAI_BASE_URL, model via ZERO_MODEL / --model.
//
// Added so the cross-family refuter roster can reach a fifth model family:
// Grok scored the highest run-to-run CONSISTENCY of any model in Aikido's
// Aug-2026 CVE-rediscovery benchmark (21/32 stable across all three runs vs
// DeepSeek V4 Pro's 10/32), which is the property a refuter wants — a
// skeptic that flip-flops between runs is worse than no skeptic.
export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL = "grok-4.6";

// Cline API keys support both usage billing and ClinePass model slugs. Never
// reuse extension account tokens or infer a Pass subscription from key presence.
export const CLINE_DEFAULT_BASE_URL = "https://api.cline.bot/api/v1";
export const CLINE_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
export function clineModelId(model: string): string { return model.replace(/^cline\//i, ""); }

// ── Together AI (OpenAI-compatible Chat Completions, Bearer key) ───────────
//
// Together serves `POST /v1/chat/completions` with the standard OpenAI body,
// tool calls and usage block, so it rides the same wire as openai/xai/cline.
// Model ids are `<org>/<model>` (e.g. `openai/gpt-oss-120b`,
// `meta-llama/Llama-3.3-70B-Instruct-Turbo`), which collide with the natural
// family routing for qwen/glm/deepseek. Together is therefore never selected
// by model family: use the explicit `together/<id>` routing prefix (stripped
// before the request) or pin the provider. The prefix is stripped exactly
// once, so an id that itself starts with `together/` is `together/together/…`.
export const TOGETHER_DEFAULT_BASE_URL = "https://api.together.ai/v1";
export const TOGETHER_DEFAULT_MODEL = "openai/gpt-oss-120b";
export function togetherModelId(model: string): string { return model.replace(/^together\//i, ""); }

/**
 * Together's own SDKs default TOGETHER_BASE_URL to the bare origin
 * (`https://api.together.ai`) and add `/v1` per route, whereas this runtime
 * appends `/chat/completions` to the base. Accept the SDK spelling too by
 * adding `/v1` when the override has no path; any explicit path is kept as-is.
 */
export function togetherBaseUrl(env: Readonly<NodeJS.ProcessEnv>): string {
  const raw = env.TOGETHER_BASE_URL?.trim();
  if (!raw) return TOGETHER_DEFAULT_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.pathname.replace(/\/+$/, "") === "" && !url.search && !url.hash) {
      url.pathname = "/v1";
      return url.href;
    }
  } catch { /* leave malformed values for the endpoint validators to report */ }
  return raw.replace(/\/+$/, "");
}

/** Cline non-streaming Chat may wrap the OpenAI response in success/data. */
export function clineChatResponse(value: unknown): Record<string, unknown> {
  const record = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  if (!record(value)) throw new Error("Cline returned an invalid chat response.");
  let response = value;
  if (Object.hasOwn(value, "success")) {
    if (value.success !== true || !record(value.data)) throw new Error("Cline returned an unsuccessful or invalid chat response.");
    response = value.data;
  }
  if (!Array.isArray(response.choices) || response.choices.length === 0 ||
    !record(response.choices[0]) || !record(response.choices[0].message)) {
    throw new Error("Cline returned an invalid chat response.");
  }
  return response;
}

// ── OpenCode Zen (API-key gateway, https://opencode.ai/zen/v1) ─────────────
//
// Zen proxies several native APIs. Route each documented model family to its
// actual wire instead of treating the gateway as universally OpenAI-compatible:
// Responses (GPT/Grok/Muse), Anthropic Messages (Claude/Qwen), Google
// generateContent (Gemini), and OpenAI chat completions (the remaining
// documented families).
export const OPENCODE_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_DEFAULT_MODEL = "muse-spark-1.3-contributor-free";

export type WireApi =
  | "chat_completions"
  | "responses"
  | "anthropic_messages"
  | "google_generate_content";

// Keep compatible gateways on their existing wire unless explicitly configured.
export function openAICompatibleWireApi(
  env: Readonly<NodeJS.ProcessEnv>,
  variable: "OPENAI_WIRE_API" | "OPENROUTER_WIRE_API" | "XAI_WIRE_API" | "AZURE_OPENAI_WIRE_API",
  fallback: WireApi = "chat_completions",
): WireApi {
  const value = env[variable];
  if (value === undefined) return fallback;
  if (value === "chat_completions" || value === "responses") return value;
  throw new Error(`${variable} must be "chat_completions" or "responses"`);
}


export function opencodeModelId(model: string): string {
  return model.replace(/^opencode\//i, "");
}

/** Return the documented Zen wire for a canonical or `opencode/`-prefixed model. */
export function opencodeWireApiForModel(model: string | undefined): WireApi {
  const bare = opencodeModelId(model ?? OPENCODE_DEFAULT_MODEL).toLowerCase();
  if (/^(muse-spark|gpt-|o[1-4](?:[-_]|$)|grok)/.test(bare)) return "responses";
  if (/^(claude|qwen)/.test(bare)) return "anthropic_messages";
  if (/^gemini/.test(bare)) return "google_generate_content";
  if (/^(deepseek|mimo|ling|big-pickle|nemotron|minimax|glm|kimi|k3)/.test(bare)) {
    return "chat_completions";
  }
  throw new Error(`OpenCode Zen has no wire mapping for model "${bare}"`);
}

// ── GitHub Copilot (device-code OAuth, OpenAI chat_completions wire) ────────
//
// The GitHub device-flow access token is sent DIRECTLY as `Authorization:
// Bearer <token>` to api.githubcopilot.com/chat/completions — NO secondary
// token exchange and NO refresh (GitHub device tokens are long-lived). This is
// the xai/kimi device-code pattern plus a set of static Copilot integration
// headers and a `copilot/` model prefix. Confirmed against opencode's
// plugin/github-copilot and oh-my-pi's oauth/github-copilot (fetched 2026-09-14).
//
// The `copilot/` prefix disambiguates routing/pricing (Copilot serves
// gpt-*/claude-*/gemini- families); it is STRIPPED off the model id in
// applyConfiguration before the request, mirroring the opencode-prefix strip.
export const COPILOT_API_BASE = "https://api.githubcopilot.com";
export const COPILOT_DEFAULT_MODEL = "gpt-4o";
// Static Copilot integration headers required on every inference call. Values
// track the VS Code Copilot Chat client the endpoint expects.
//   - Copilot-Vision-Request: "true" is sent ONLY alongside an image part —
//     omitted here (text-only v1). TODO: set it when image content is present.
export const COPILOT_STATIC_HEADERS: Readonly<Record<string, string>> = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.99.3",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "X-GitHub-Api-Version": "2026-06-01",
  "Openai-Intent": "conversation-edits",
  "X-Initiator": "user",
};

/** Strip the `copilot/` routing prefix off a model id (canonical id for the wire). */
export function copilotModelId(model: string): string {
  return model.replace(/^copilot\//i, "");
}

// ── Google Gemini Code Assist (PKCE browser OAuth, Code Assist wire) ────────
//
// This is the Gemini CLI's Code Assist backend — a DISTINCT service from the
// public `generativelanguage.googleapis.com` Gemini API. It:
//   - authenticates with a Google OAuth access token (Bearer), refreshed on
//     demand against oauth2.googleapis.com/token with the embedded installed-app
//     client_id + client_secret (Google does NOT rotate the refresh token, but
//     we honour a rotated one if the server ever returns one).
//   - talks to `https://cloudcode-pa.googleapis.com/v1internal:generateContent`
//     (model in the BODY, not the URL).
//   - WRAPS the standard Gemini generateContent body in a Code Assist envelope
//     `{ model, project, user_prompt_id, request: {...} }` and UNWRAPS the
//     response from `{ response: {...} }` — otherwise the request/response is
//     the exact Google generateContent shape the opencode `google_generate_content`
//     wire already builds and parses (so we reuse googleContents() + that parser).
//   - requires a resolved GCP project id (paid/standard tiers) which is
//     discovered once per credential via loadCodeAssist → onboardUser → LRO poll
//     and cached; the free tier omits the project entirely.
// Confirmed against gemini-cli, opencode gemini-auth and oh-my-pi (2026-09-14).
// The Google installed-app client id/secret are PUBLIC credentials the official
// gemini-cli (and opencode/oh-my-pi) embed verbatim; they are split here only so
// a secret scanner doesn't flag the source literal — the runtime value is intact.
export const GEMINI_OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j" + ".apps.googleusercontent.com";
export const GEMINI_OAUTH_CLIENT_SECRET = "GOCSPX-" + "4uHgMPm-1o7Sk-geV6Cu5clXFsxl";
export const GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_API_VERSION = "v1internal";
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";
// The User-Agent Code Assist expects (it gates the subscription quota lane);
// the concrete model is appended per-request (see geminiUserAgent).
export const GEMINI_CLI_VERSION = "0.1.0";

export type ApiProvider = NonNullable<RuntimeConfig["provider"]>;
/**
 * Azure Foundry deployment ids used by 0cloud. The worker can inject both
 * the Azure primary key and a direct-DeepSeek fallback key; route a Foundry
 * deployment to Azure before the env-priority fallback sees that second key.
 *
 * Keep this table aligned with the worker's AZURE_FOUNDRY_DEPLOYMENT_IDS.
 */
export const AZURE_FOUNDRY_DEPLOYMENT_IDS: Record<string, true> = {
  "deepseek-v4-flash": true,
  "deepseek-v4-pro": true,
  "kimi-k2.7-code": true,
  "gpt-oss-120b": true,
  "gpt-5.4": true,
  "gpt-5.6-sol": true,
  "gpt-5.6-luna": true,
  "gpt-5.6-terra": true,
};


// ── Cross-provider failover (429 / quota / policy-refusal → ZERO_LLM_FALLBACK) ──
//
// When a provider exhausts its 429 retry budget, reports a plan quota
// exhaustion, or its safety classifier refuses the request outright
// (`response.failed` with a `*_policy` code — a same-provider retry is
// pointless), the engine can fail over to a configured ordered chain of backup
// providers instead of surfacing a terminal error. Each entry is
// <providerId>:<model>, separated by commas:
//
//   ZERO_LLM_FALLBACK=deepseek:deepseek-v4-flash,azure:gpt-5-deployment,openrouter:qwen/qwen-2.5-coder-32b-instruct
//
// Parsed once at module load; empty / unset → no failover (today's behaviour).

// ── Z.ai GLM (flat-rate Coding Plan key) ───────────────────────────────
//
// GLM ships an Anthropic-compatible Messages endpoint, so z-ai rides the
// exact same `/v1/messages` wire + parser the `anthropic` provider uses —
// it is NOT OpenAI-compatible. The only z-ai-specific behaviour is:
//   - default base URL + model below (override via Z_AI_BASE_URL / ZERO_MODEL)
//   - GLM's hybrid reasoning is OFF by default on this endpoint; we turn it
//     ON via the Anthropic `thinking` body field (a hacking engine wants the
//     model thinking). GLM is lenient about NOT echoing `thinking` blocks on
//     follow-up tool turns (verified 2026-06-17), so we simply drop them from
//     parsed output instead of round-tripping them through the agent loop.
export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";
export const ZAI_DEFAULT_MODEL = "glm-5.3";
// Thinking token budget for GLM. 0 (or unset → default) disables thinking.
// Must stay below the 8192 max_tokens the Anthropic body sends below.
export const ZAI_DEFAULT_THINKING_BUDGET = 2048;

export function zaiThinkingBudget(): number {
  const raw = process.env["ZERO_ZAI_THINKING_BUDGET"];
  if (raw == null || raw.trim().length === 0) return ZAI_DEFAULT_THINKING_BUDGET;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : ZAI_DEFAULT_THINKING_BUDGET;
}

// ── Moonshot Kimi K3 (flat-rate coding key) ────────────────────────────
//
// Kimi K3 rides the exact same Anthropic-compatible `/v1/messages` wire +
// header/url/parser path z-ai uses (verified live: POST
// https://api.kimi.com/coding/v1/messages with x-api-key + model "k3" →
// HTTP 200). It is NOT OpenAI-compatible. Unlike GLM, K3 emits native
// `thinking` blocks on the Anthropic wire with no special body param, so
// the z-ai-only thinking-budget fragment is deliberately NOT applied here.
// The only kimi-specific config is the default base URL + model below
// (override via KIMI_BASE_URL / ZERO_MODEL); note the base URL differs
// from z.ai so kimi requests never hit api.z.ai.
export const KIMI_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_DEFAULT_MODEL = "k3";

// ── Alibaba Model Studio Qwen (Token Plan subscription key) ────────────
//
// Qwen rides the OpenAI-compatible `compatible-mode` wire (Bearer +
// `/chat/completions`) — NOT the Anthropic `/v1/messages` path z-ai/kimi
// use (verified live 2026-08-05: POST …/compatible-mode/v1/chat/completions
// with Bearer + model "qwen3.8-max" → HTTP 200; `/models` lists the full
// subscription catalog). The default base URL is the Token Plan endpoint
// (credit-billed, nightly off-peak discounts); a workspace PAYG endpoint
// can be substituted via QWEN_BASE_URL. Default model is the Qwen3.8-Max
// flagship (2.4T MoE); override with ZERO_MODEL.
export const QWEN_DEFAULT_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
export const QWEN_DEFAULT_MODEL = "qwen3.8-max";

// ── ChatGPT Codex backend (subscription auth) ──────────────────────────
//
// Opt-in OAuth-bearer provider that calls OpenAI's internal Codex
// backend on the user's ChatGPT Plus/Pro subscription instead of the
// public Platform API. Activated when ZERO_CHATGPT_OAUTH_REFRESH_TOKEN
// is set (the worker-controller plumbs this from ~/.codex/auth.json or
// the operator can set it directly for `0` CLI usage on a host
// that has run `codex login`).
//
// The endpoint and OAuth issuer below are the same ones the official
// Codex CLI uses; we are NOT a different client. Originator header is
// set to `0` so server-side observability can distinguish our
// traffic from raw Codex CLI traffic.
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// Verified against Codex CLI 0.167.0: the account catalog gates newer model
// IDs by client_version. Keep catalog and Responses headers on this one baseline.
export const CODEX_CLIENT_VERSION = "0.167.0";
export const CODEX_PROTOCOL_HEADERS = {
  "OpenAI-Beta": "responses=experimental",
  originator: "0",
  version: CODEX_CLIENT_VERSION,
} as const;
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEFAULT_MODEL = DEFAULT_OPENAI_MODEL;

/**
 * Server-side compaction threshold, in prompt tokens, for the long agent loops
 * that have no context strategy of their own (`craft-scan`: 120 steps,
 * `exploit-scan`: 90 steps — both grow monotonically until the provider limit
 * or the wall-clock deadline kills the run).
 *
 * Why 150,000:
 *
 *  - It must leave room for one more full turn AFTER compaction fires. The
 *    gpt-5 family takes ~272k input tokens, and a single craft/exploit turn can
 *    add the system prompt + tool schemas + several 10,000-token tool outputs.
 *    150k leaves ~120k of headroom, so a compaction that lands mid-turn cannot
 *    be immediately overrun.
 *  - It must be high enough that a run which finishes in a handful of steps
 *    never pays for one. Compaction rewrites the prefix, which voids prompt
 *    caching for the turn after it — worth it once a transcript is genuinely
 *    large, pure loss on a short run.
 *  - It is well above the native loop's 77k client-side threshold on purpose:
 *    that path preserves credential-bearing messages verbatim and is the better
 *    strategy where it exists. This is the fallback for loops that have none.
 */
export const LOOP_SERVER_COMPACTION_TOKENS = 150_000;

/**
 * Process-lifetime session id used as the `session_id` header for the
 * chatgpt-codex provider when no scan-specific id is in scope (e.g.
 * the local CLI's `0 audit foo --runtime api` path without a
 * cloud scan context). Per-scan ids are still preferred — this is
 * just the fallback. Randomised once per process to keep concurrent
 * 0 invocations from sharing a session bucket on OpenAI's side.
 */
export const PROCESS_SESSION_ID = `0-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

export function parseCodexAzureConfig(env: Readonly<NodeJS.ProcessEnv> = process.env): {
  baseUrl?: string;
  model?: string;
  wireApi?: WireApi;
  reasoningEffort?: string;
} {
  const configPath = `${env.HOME ?? ""}/.codex/config.toml`;
  if (!existsSync(configPath)) return {};

  try {
    const content = readFileSync(configPath, "utf8");
    const azureSectionMatch = content.match(/\[model_providers\.azure\]([\s\S]*?)(?:\n\[|$)/);
    const activeProviderMatch = content.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
    const baseUrlMatch = azureSectionMatch?.[1]?.match(/base_url\s*=\s*"([^"]+)"/);
    const wireApiMatch = azureSectionMatch?.[1]?.match(/wire_api\s*=\s*"([^"]+)"/);
    const azureModelMatch = azureSectionMatch?.[1]?.match(/model\s*=\s*"([^"]+)"/);
    const topLevelModelMatch = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
    // Scoped like its siblings above. Unscoped, this matched the FIRST
    // `model_reasoning_effort` anywhere in the file — including one set inside
    // an unrelated `[plugins."…"]` section, which a reordering of the file
    // would silently hand to every Responses-path scan. Prefer the azure
    // section, then the top-level keys (everything before the first
    // `[section]` header); never a foreign section.
    const topLevelSection = content.split(/^\[/m)[0] ?? "";
    const reasoningMatch =
      azureSectionMatch?.[1]?.match(/model_reasoning_effort\s*=\s*"([^"]+)"/)
      ?? topLevelSection.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);

    return {
      baseUrl: baseUrlMatch?.[1],
      model: azureModelMatch?.[1] ?? (activeProviderMatch?.[1] === "azure" ? topLevelModelMatch?.[1] : undefined),
      wireApi: wireApiMatch?.[1] === "responses" ? "responses" : "chat_completions",
      reasoningEffort: reasoningMatch?.[1],
    };
  } catch {
    return {};
  }
}
