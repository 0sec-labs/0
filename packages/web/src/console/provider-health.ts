import type { ModelChoice } from "@/lib/last-model-choice";

/** Whether a connection's key actually works (server probe), not merely whether one is present. */
export type HealthState = "ok" | "rejected" | "unreachable" | "unknown";
export interface ProviderHealth { state: HealthState; checking?: boolean; hint?: string | null }
export interface HealthProvider {
  id: string; label?: string; configured: boolean; source?: string | null;
  health?: ProviderHealth; environmentVariable?: string | null;
}
interface CatalogRow { id: string; provider: string; enabled?: boolean }
interface RecommendedPick { role: string; providerId: string; model: string }

/** A provider whose key was refused or that did not answer must never be picked for the user. */
export const providerUnusable = (provider: Pick<HealthProvider, "health"> | undefined): boolean =>
  provider?.health?.state === "rejected" || provider?.health?.state === "unreachable";

export function unusableProviderIds(providers: readonly HealthProvider[] | undefined): Set<string> {
  return new Set((providers ?? []).filter(providerUnusable).map(provider => provider.id));
}

/** Drop a choice whose provider is rejected/unreachable; report what was skipped so the UI can say why. */
export function skipUnusableChoice(choice: ModelChoice | undefined, unusable: ReadonlySet<string>): { choice?: ModelChoice; skipped?: ModelChoice } {
  if (!choice) return {};
  return unusable.has(choice.providerId) ? { skipped: choice } : { choice };
}

/**
 * The model a new thread starts on: the first usable of remembered, host default, recommended and the provider's
 * own default. Candidates from a rejected/unreachable provider are skipped, never silently used.
 */
export function resolveStartChoice(candidates: { remembered?: ModelChoice; explicit?: ModelChoice; recommended?: ModelChoice; saved?: ModelChoice }, unusable: ReadonlySet<string>): { choice?: ModelChoice; skipped?: ModelChoice } {
  let skipped: ModelChoice | undefined;
  for (const candidate of [candidates.remembered, candidates.explicit, candidates.recommended, candidates.saved]) {
    const result = skipUnusableChoice(candidate, unusable);
    if (result.choice) return { choice: result.choice, skipped: skipped ?? result.skipped };
    skipped ??= result.skipped;
  }
  return { skipped };
}

/** Which model one click can switch to when `failedProviderId` rejected the key: recommended picks first, then any listed model. */
export function nextHealthyChoice({ providers, models, recommended = [], failedProviderId }: {
  providers: readonly HealthProvider[]; models: readonly CatalogRow[]; recommended?: readonly RecommendedPick[]; failedProviderId?: string;
}): (ModelChoice & { providerLabel: string }) | undefined {
  const usable = new Map(providers.filter(provider => provider.configured && !providerUnusable(provider) && provider.id !== failedProviderId).map(provider => [provider.id, provider.label ?? provider.id]));
  const listed = (providerId: string, model: string) => models.some(row => row.provider === providerId && row.id === model && row.enabled !== false);
  const pick = [...recommended].sort((a, b) => Number(b.role === "orchestrator") - Number(a.role === "orchestrator")).find(item => usable.has(item.providerId) && listed(item.providerId, item.model));
  if (pick) return { providerId: pick.providerId, model: pick.model, providerLabel: usable.get(pick.providerId)! };
  const row = models.find(item => usable.has(item.provider) && item.enabled !== false);
  return row ? { providerId: row.provider, model: row.id, providerLabel: usable.get(row.provider)! } : undefined;
}

export interface HealthBadge { label: string; tone: "success" | "warning" | "danger" | "neutral" }
/** Green "Connected" only when the probe said ok. */
export function healthBadge(provider: HealthProvider, rowHealthy: boolean, inactive = false): HealthBadge {
  if (!rowHealthy) return { label: "Needs connection", tone: "warning" };
  const state = provider.health?.state ?? "unknown";
  if (state === "rejected") return { label: "Key rejected", tone: "danger" };
  if (state === "unreachable") return { label: "Can't reach", tone: "warning" };
  if (inactive) return { label: "Inactive", tone: "neutral" };
  if (state === "ok") return { label: "Connected", tone: "success" };
  return { label: provider.health?.checking ? "Checking…" : "Connected", tone: "neutral" };
}

/** Plain one-line hint under a bad badge. */
export function healthHint(provider: HealthProvider): string | null {
  const state = provider.health?.state;
  if (state === "rejected") return provider.health?.hint ?? (provider.source === "environment" ? `Set ${provider.environmentVariable ?? "the API key variable"} in your environment` : "Update the key");
  if (state === "unreachable") return provider.health?.hint ?? "Check your network or the API endpoint";
  return null;
}

/** Where a provider's credential comes from, in words. */
export function credentialOrigin(provider: HealthProvider, hasSavedAccount: boolean): string | null {
  if (provider.source !== "environment") return null;
  return hasSavedAccount
    ? `From environment (${provider.environmentVariable ?? "variable"}), which wins over the saved key`
    : "From environment";
}

/** Names the provider and model that failed, in plain words. */
export function rejectedKeyHeadline(providerLabel: string | undefined, model: string | undefined): string {
  const who = providerLabel ?? "The model provider";
  return `${who} rejected your key${model ? ` for ${model}` : ""}.`;
}

/**
 * Thread-start check: lets the server finish its bounded key probes (`wait=1`) and says whether any connection can answer.
 * A failed lookup never blocks sending.
 */
export async function anyHealthyProvider(fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>): Promise<boolean> {
  try {
    const data = await fetchJson<{ providers: (HealthProvider & { diagnostics?: { valid: boolean } })[] }>("/api/console/providers?wait=1");
    return data.providers.some(provider => provider.configured && provider.diagnostics?.valid !== false && !providerUnusable(provider));
  } catch { return true; }
}

const PROVIDER_NAMES: Record<string, string> = { "chatgpt-plan": "ChatGPT plan", "chatgpt-codex": "ChatGPT / Codex", openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter", deepseek: "DeepSeek", xai: "xAI", "z-ai": "Z.ai", kimi: "Kimi", qwen: "Qwen", azure: "Azure OpenAI", opencode: "OpenCode", together: "Together AI" };

export interface RejectedBanner {
  headline: string;
  /** Provider row to open in Connections. */
  providerId?: string;
  /** One-click switch target, when another connection is healthy. */
  next?: ModelChoice & { providerLabel: string };
}
/** Everything the "key rejected" banner shows and offers, from the failed run's runtime and the current provider health. */
export function rejectedBanner({ runtime, providers, models, recommended }: {
  runtime?: { providerId?: string; model?: string } | null; providers: readonly HealthProvider[];
  models: readonly CatalogRow[]; recommended?: readonly RecommendedPick[];
}): RejectedBanner {
  const providerId = runtime?.providerId;
  const label = providerId ? providers.find(provider => provider.id === providerId)?.label ?? PROVIDER_NAMES[providerId] ?? providerId : undefined;
  const next = nextHealthyChoice({ providers, models, recommended, failedProviderId: providerId });
  return { headline: rejectedKeyHeadline(label, runtime?.model), providerId, next };
}
