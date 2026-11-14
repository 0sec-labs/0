import { MODEL_OFF_HINT, isModelEnabled, providerLabel, type CatalogModel } from "@/components/model-picker";

export interface ProviderLike { id: string; label: string; configured: boolean }
export interface ProviderDiagnostic { providerId: string; message: string }

/** Strip anything key-like before provider error text reaches the DOM, even a title attribute. */
export function redactProviderError(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]")
    .replace(/([?&;\s"']?(?:api[-_]?key|key|token|secret|password|authorization|sig|signature)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xox[abprs]|AIza|AKIA|ya29)[-_.]?[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

export interface FailingProvider { providerId: string; label: string; title: string }
/** One quiet row per failing provider; the raw message only survives, redacted, as a tooltip. */
export function failingProviders(diagnostics: readonly ProviderDiagnostic[], providers: readonly Pick<ProviderLike, "id" | "label">[]): FailingProvider[] {
  const seen = new Set<string>(), rows: FailingProvider[] = [];
  for (const item of diagnostics) {
    if (seen.has(item.providerId)) continue;
    seen.add(item.providerId);
    rows.push({ providerId: item.providerId, label: providers.find(provider => provider.id === item.providerId)?.label ?? providerLabel(item.providerId), title: redactProviderError(item.message) });
  }
  return rows;
}

export interface ModelRow { key: string; id: string; providerId: string; providerLabel: string; detail: string; disabled: boolean; hint?: string }
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
/** Models of connected providers only, deduplicated (account rows win), grouped by provider in first-seen order. */
export function modelRows(models: readonly CatalogModel[], providers: readonly ProviderLike[]): ModelRow[] {
  const connected = new Map(providers.filter(provider => provider.configured).map(provider => [provider.id, provider.label]));
  const unique = new Map<string, CatalogModel>();
  for (const model of models) {
    if (!connected.has(model.provider)) continue;
    const key = `${model.provider}:${model.id}`;
    if (!unique.has(key) || model.source === "account") unique.set(key, model);
  }
  const order = [...new Set([...unique.values()].map(model => model.provider))];
  return [...unique.values()].sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider)).map(model => {
    const enabled = isModelEnabled(model);
    return {
      key: `${model.provider}:${model.id}`, id: model.id, providerId: model.provider, providerLabel: connected.get(model.provider)!, disabled: !enabled,
      hint: enabled ? undefined : MODEL_OFF_HINT,
      detail: [model.contextWindowTokens && model.contextWindowTokens > 0 ? `${compact.format(model.contextWindowTokens)} context` : undefined, model.price || undefined].filter(Boolean).join(" · "),
    };
  });
}

export type ModelsPageState = "loading" | "empty" | "ready";
export function modelsPageState({ providers, loading }: { providers: readonly ProviderLike[] | undefined; loading: boolean }): ModelsPageState {
  if (!providers) return loading ? "loading" : "empty";
  return providers.some(provider => provider.configured) ? "ready" : "empty";
}

/** Capy-style sentence for the quiet "reset" link: shown only when the choice differs from the saved default. */
export function differsFromDefault(current: { providerId: string; model: string }, preference: { providerId: string; model: string } | null | undefined): boolean {
  return !!preference && (current.providerId !== preference.providerId || current.model !== preference.model);
}
