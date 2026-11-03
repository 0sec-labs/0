import { hasKnownPricing, modelNormalizationStages, normalizeModel, registerModelPricing, type ModelRates } from "./pricing.js";

/**
 * Runtime pricing discovery for routed model ids that no bundled feed covers
 * (e.g. `openrouter/z-ai/glm-5.3-flash`). The public OpenRouter catalog
 * (`/api/v1/models`) publishes exact per-token rates for every routed id, so
 * a single fetch prices the whole router tail without bundling their catalog.
 *
 * The catalog is fetched once per process (single-flight, failure-tolerant —
 * a failed fetch is retried on the next discovery, never cached). Rates are
 * registered under BOTH the raw session id and the vendor-normalized id so
 * `getRates`/`hasKnownPricing` resolve either spelling.
 */

const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

export type PricingDiscoveryFetch = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

type OpenRouterModelEntry = { id?: unknown; pricing?: unknown };

interface CatalogRates {
  prompt: unknown;
  completion: unknown;
  input_cache_read: unknown;
}

interface CatalogBody {
  data?: unknown;
}

let configuredFetch: PricingDiscoveryFetch | undefined;
const catalogCache = new Map<PricingDiscoveryFetch, Promise<Map<string, ModelRates>>>();

/** Replace the discovery fetch (default `globalThis.fetch`) and drop the catalog cache. Test hook. */
export function setPricingDiscoveryFetch(fetchImpl?: PricingDiscoveryFetch): void {
  configuredFetch = fetchImpl;
  catalogCache.clear();
}

/** Restore the default discovery fetch and drop the catalog cache. Test hook. */
export function resetPricingDiscovery(): void {
  configuredFetch = undefined;
  catalogCache.clear();
}

function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const perToken = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return perToken * 1e6;
}

/** Convert an OpenRouter catalog entry's per-token pricing strings into per-million ModelRates. */
export function ratesFromCatalogEntry(entry: OpenRouterModelEntry): ModelRates | undefined {
  const pricing = (entry.pricing !== null && typeof entry.pricing === "object" && !Array.isArray(entry.pricing) ? entry.pricing : {}) as Partial<CatalogRates>;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = perMillion(pricing.input_cache_read);
  return cachedInput !== undefined ? { input, output, cachedInput } : { input, output };
}

function isFetch(impl: unknown): impl is PricingDiscoveryFetch {
  return typeof impl === "function";
}

function loadCatalog(impl: PricingDiscoveryFetch): Promise<Map<string, ModelRates>> {
  let catalog = catalogCache.get(impl);
  if (!catalog) {
    catalog = fetchCatalog(impl).catch((error: unknown) => {
      catalogCache.delete(impl);
      throw error;
    });
    catalogCache.set(impl, catalog);
  }
  return catalog;
}

async function fetchCatalog(impl: PricingDiscoveryFetch): Promise<Map<string, ModelRates>> {
  const response = await impl(OPENROUTER_MODELS_ENDPOINT, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenRouter catalog returned HTTP ${response.status}`);
  const body = await response.json() as CatalogBody;
  if (!Array.isArray(body.data)) throw new Error("OpenRouter catalog returned an unexpected payload");
  const catalog = new Map<string, ModelRates>();
  for (const entry of body.data) {
    if (entry === null || typeof entry !== "object" || typeof (entry as OpenRouterModelEntry).id !== "string") continue;
    const rates = ratesFromCatalogEntry(entry as OpenRouterModelEntry);
    if (rates) catalog.set((entry as OpenRouterModelEntry).id as string, rates);
  }
  return catalog;
}

/** Look up `model` (raw or vendor-normalized) in the OpenRouter catalog and register
 * the rates under both spellings. No-op when pricing is already known, and never
 * throws — catalog unavailability just leaves the model costUnavailable. */
export async function discoverAndRegisterPricing(model: string, fetchImpl?: PricingDiscoveryFetch): Promise<void> {
  try {
    if (!model || hasKnownPricing(model)) return;
    const impl = isFetch(fetchImpl) ? fetchImpl : configuredFetch ?? globalThis.fetch;
    const catalog = await loadCatalog(impl);
    let rates: ModelRates | undefined;
    for (const key of modelNormalizationStages(model)) {
      rates = catalog.get(key);
      if (rates) break;
    }
    if (!rates) return;
    registerModelPricing(model, rates);
    const normalized = normalizeModel(model);
    if (normalized !== model) registerModelPricing(normalized, rates);
  } catch {
    // Discovery is best-effort; pricing stays unavailable until a later usage event retries.
  }
}
