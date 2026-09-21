/**
 * Jev evaluator configuration helper for the CLI/TUI console.
 *
 * Reads operator settings and stored credentials to build a
 * `ConsoleJevConfig` that Core consumes. Jev credentials are never leaked into
 * the LLM runtime's environment — they stay inside this module's control path.
 *
 * Precedence (highest first):
 *   1. Explicit UI setting "off" — always disables, even with env vars
 *   2. Explicit UI setting "typesafe"/"vercel"/"cloud" — uses stored or
 *      env-supplied credentials for that provider; warns if missing
 *   3. UI setting "environment" — resolves legacy env vars (0SEC_JEV_PROVIDER,
 *      0SEC_JEV_FEATURES, TYPESAFE_API_KEY, etc.)
 *   4. Absent or no env vars → Jev is unavailable (no config returned)
 *
 * The funding enum "environment" is the default so existing env-configured
 * users continue working without opening the settings dialog.
 */

import { loadAccountStore, getActiveAccount, type AccountStore } from "./credential-store.js";
import { loadCloudCredentials } from "@0/core"
import type { ConsoleJevConfig, ConsoleJevActivity, JevFeature } from "@0/shared"
import type { TuiSettings } from "./settings.js";

/** Which TUI setting maps to which Jev feature toggle. */
const FEATURE_SETTING_KEYS = ["jevBrowser", "jevKernel", "jevCrash", "jevRadar", "jevFoxguard"] as const;
type FeatureSettingKey = typeof FEATURE_SETTING_KEYS[number];

/** The JevFeature each toggle controls. */
const FEATURE_MAP: Record<FeatureSettingKey, JevFeature> = {
  jevBrowser: "browser",
  jevKernel: "kernel",
  jevCrash: "crash",
  jevRadar: "radar",
  jevFoxguard: "foxguard",
};

/** The env-var key each Jev provider's token maps to. Cloud Jev uses
 *  loadCloudCredentials, not a stored jev-cloud key, so it is omitted here. */
const JEV_PROVIDER_ENV: Record<string, string> = {
  typesafe: "TYPESAFE_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
};

/** Provider id used in the credential store for each Jev provider. */
const JEV_CREDENTIAL_PROVIDER: Record<string, string> = {
  typesafe: "jev-typesafe",
  vercel: "jev-vercel",
};

/**
 * Build a ConsoleJevConfig from the operator's TUI settings and stored
 * credentials. Returns undefined when Jev is unavailable or explicitly off.
 *
 * When settings say "environment", env vars are consulted for backward
 * compatibility with the existing 0SEC_JEV_* variables. When a provider is
 * explicitly selected, stored credentials are tried first, then env vars.
 *
 * @param settings  Current TuiSettings (only jev* fields read)
 * @param env       Process environment, for env-based resolution
 * @param homeDir   Home directory for credential store lookup
 */
export function buildConsoleJevConfig(
  settings: Pick<TuiSettings, "jevFunding" | "jevBrowser" | "jevKernel" | "jevCrash" | "jevRadar" | "jevFoxguard" | "jevMaxRequests" | "jevMaxCostUsd">,
  env: Record<string, string | undefined> = process.env,
  homeDir?: string,
): ConsoleJevConfig | false | undefined {
  const funding = settings.jevFunding ?? "environment";

  // Explicit "off" wins over everything, including env vars.
  if (funding === "off") return false;

  // Collect enabled features from the settings toggles.
  const features: JevFeature[] = [];
  for (const key of FEATURE_SETTING_KEYS) {
    if (settings[key as FeatureSettingKey]) {
      features.push(FEATURE_MAP[key as FeatureSettingKey]);
    }
  }

  // Resolve the budget from settings presets (string enums mapped to numbers).
  const REQUEST_PRESETS: Record<string, number | undefined> = {
    "10": 10, "25": 25, "50": 50, "100": 100, "250": 250, "1000": 1000, "unlimited": undefined,
  };
  const maxRequests = (settings.jevMaxRequests && REQUEST_PRESETS[settings.jevMaxRequests] !== undefined
    ? REQUEST_PRESETS[settings.jevMaxRequests]
    : undefined) ?? 100;

  const COST_PRESETS: Record<string, number | undefined> = {
    "5": 5, "10": 10, "25": 25, "50": 50, "100": 100, "250": 250, "unlimited": undefined,
  };
  const maxCostUsd = (settings.jevMaxCostUsd && COST_PRESETS[settings.jevMaxCostUsd] !== undefined
    ? COST_PRESETS[settings.jevMaxCostUsd]
    : undefined) ?? 10;

  if (funding === "environment") {
    // Legacy env-based resolution. Only enables Jev when env explicitly requests it.
    if (!env["0SEC_JEV_FEATURES"] && !env["0SEC_JEV_PROVIDER"]) return undefined;
    // The env vars define features independently of settings toggles.
    // If features array is non-empty from env, use them; else fall back to toggle list.
    const envFeatures: JevFeature[] = (env["0SEC_JEV_FEATURES"] ?? "").split(",")
      .map((s) => s.trim()).filter(Boolean)
      .filter((s): s is JevFeature => s === "browser" || s === "kernel" || s === "crash" || s === "radar" || s === "foxguard");
    const provider = (env["0SEC_JEV_PROVIDER"] ?? "").trim().toLowerCase();
    const actualProvider = provider === "typesafe" ? "typesafe"
      : provider === "vercel" ? "vercel"
      : provider === "cloud" ? "cloud"
      : "vercel"; // default

    if (actualProvider === "cloud") {
      try {
        const cloud = loadCloudCredentials({ env: env as NodeJS.ProcessEnv, homeDir });
        const effectiveFeatures = envFeatures.length > 0 ? envFeatures : features;
        return {
          provider: "cloud",
          features: effectiveFeatures,
          maxRequests,
          maxCostUsd,
          cloud: { host: cloud.host, token: cloud.token },
        };
      } catch {
        return undefined;
      }
    }

    const apiKey = env[JEV_PROVIDER_ENV[actualProvider]]?.trim();
    const effectiveFeatures = envFeatures.length > 0 ? envFeatures : features;

    return {
      provider: actualProvider as "typesafe" | "vercel" | "direct",
      features: effectiveFeatures,
      maxRequests,
      maxCostUsd,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  // Explicit provider selection.
  if (funding === "cloud") {
    // Cloud Jev reuses the normal 0cloud account credential (loadCloudCredentials).
    // No separate jev-cloud store entry or env var needed.
    try {
      const cloud = loadCloudCredentials({ env: env as NodeJS.ProcessEnv, homeDir });
      return {
        provider: "cloud",
        features,
        maxRequests,
        maxCostUsd,
        cloud: { host: cloud.host, token: cloud.token },
      };
    } catch {
      // Cloud not configured — return undefined so UI shows unavailable.
      return undefined;
    }
  }

  // typesafe or vercel: look up credentials then fall back to env.
  const store = loadAccountStore(homeDir);
  const credProviderId = JEV_CREDENTIAL_PROVIDER[funding];
  const activeKey = credProviderId
    ? readApiKeyFromStore(store, credProviderId)
    : undefined;
  const apiKey = activeKey ?? env[JEV_PROVIDER_ENV[funding]]?.trim();

  if (!apiKey) return undefined;

  return {
    provider: funding as "typesafe" | "vercel",
    features,
    maxRequests,
    maxCostUsd,
    apiKey,
  };
}

/**
 * Read the active API key for a provider from the account store.
 */
function readApiKeyFromStore(
  store: AccountStore,
  providerId: string,
): string | undefined {
  const account = getActiveAccount(store, providerId);
  return account?.kind === "api_key" && account.secret.trim().length > 0
    ? account.secret
    : undefined;
}

/**
 * Build a one-line status summary of Jev state for the `printBanner` /
 * `printStatus` commands and the TUI status bar.
 */
export function describeJevState(
  config: ConsoleJevConfig | false | undefined,
  activities?: ConsoleJevActivity[],
): string {
  if (config === false) return "Jev assistance: off";
  if (config === undefined) return "Jev assistance: unavailable";
  const features = config.features.length > 0
    ? config.features.join(", ")
    : "none";
  const providerLabel = config.provider === "direct" ? "env"
    : config.provider === "typesafe" ? "TypeSafe"
    : config.provider === "vercel" ? "Vercel"
    : config.provider === "cloud" ? "Cloud" : config.provider;
  const spend = config.maxCostUsd ? `$${config.maxCostUsd.toFixed(2)}` : "unlimited";
  const reqs = config.maxRequests ?? "unlimited";
  const activitySummary = activities && activities.length > 0
    ? (() => {
        const completed = activities.filter((a) => a.status === "completed").length;
        const failed = activities.filter((a) => a.status === "unavailable").length;
        const running = activities.filter((a) => a.status === "started").length;
        const parts: string[] = [];
        if (completed > 0) parts.push(`${completed} done`);
        if (running > 0) parts.push(`${running} active`);
        if (failed > 0) parts.push(`${failed} failed`);
        return parts.length > 0 ? ` · ${parts.join(", ")}` : "";
      })()
    : "";
  return `Jev: ${providerLabel} [${features}] · ${reqs} req · ${spend}${activitySummary}`;
}

/**
 * Format a single Jev activity as a short log line for the readline transcript
 * or TUI activity feed. Never includes credentials or raw evidence.
 */
export function formatJevActivity(activity: ConsoleJevActivity): string {
  const feature = activity.feature === "prepass" ? "prepass" : activity.feature;
  const status = activity.status === "started" ? "started"
    : activity.status === "completed" ? "✓"
    : "✗";

  const cost = activity.estimatedCostUsd !== undefined
    ? ` ~$${activity.estimatedCostUsd.toFixed(6)}`
    : "";

  const billing = activity.billing
    ? activity.billing.status === "settled"
      ? ` · settled $${(activity.billing.chargedUsd ?? 0).toFixed(4)}`
      : ` · pending`
    : "";

  const tokens = activity.inputTokens !== undefined
    ? ` · ${activity.inputTokens}→${activity.outputTokens ?? 0} tok`
    : "";

  const duration = activity.durationMs !== undefined
    ? ` · ${activity.durationMs}ms`
    : "";

  const model = activity.model ? ` · ${activity.model}` : "";

  const message = activity.message ? ` — ${activity.message}` : "";

  return `  ${status} Jev/${feature}${model}${duration}${tokens}${cost}${billing}${message}`;
}