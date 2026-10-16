/**
 * The selectable model list behind `/model`.
 *
 * The shared pricing table supplies the offline floor; Models.dev supplies
 * newly published provider-qualified IDs and metadata. Neither registry is an
 * allowlist for inference, and public rows never establish account entitlement.
 */

import { MODEL_PRICING, getRates, modelProvider } from "@0/shared";

import type { SelectorItem } from "./selector.js";
import { loadCatalogModels, METERED_CATALOG_PROVIDERS, type CatalogSyncOptions } from "./model-catalog-sync.js";

export interface CatalogModel {
  id: string;
  provider: string;
  /** "$5/30 per M", or "free" when both rates are zero. */
  price: string;
}

/**
 * `default` is the fallback rate row for unrecognised models, not a model an
 * operator can select — offering it would set the engine to a model id that
 * no provider answers to.
 */
const NON_MODEL_PRICING_KEYS = new Set(["default"]);

/** Byte-order compare: locale-independent so the menu order never shifts. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Rates are stored as plain numbers ($/1M) with inconsistent precision —
 * 5, 2.5, 0.075. Rendering them through toFixed would print "$5.00/30.00";
 * trimming to the significant digits keeps the column narrow enough to sit
 * beside the model id in a terminal.
 */
function formatRate(value: number): string {
  return String(Number(value.toFixed(4)));
}

export function formatModelPrice(input: number, output: number): string {
  if (input === 0 && output === 0) return "free";
  return `$${formatRate(input)}/${formatRate(output)} per M`;
}

export function buildModelCatalog(currentModel?: string): CatalogModel[] {
  const models = Object.keys(MODEL_PRICING)
    .filter((id) => !NON_MODEL_PRICING_KEYS.has(id))
    .map((id) => {
      const provider = modelProvider(id);
      const rates = getRates(Object.hasOwn(METERED_CATALOG_PROVIDERS, provider) ? `${provider}/${id}` : id);
      return { id, provider, price: provider === "cline" && id.startsWith("cline-pass/") ? "ClinePass plan (access unverified)" : formatModelPrice(rates.input, rates.output) };
    });

  // The active model floats to the top: it is the row the operator most
  // often wants to confirm, and it doubles as the overlay's initial
  // highlight. Everything else groups by provider so the list reads as
  // vendor sections rather than as an alphabet soup of ids.
  return models.sort((a, b) => {
    if (a.id === currentModel) return b.id === currentModel ? 0 : -1;
    if (b.id === currentModel) return 1;
    return compareStrings(a.provider, b.provider) || compareStrings(a.id, b.id);
  });
}

export function modelSelectorItems(currentModel?: string): SelectorItem[] {
  return buildModelCatalog(currentModel).map((model) => ({
    id: model.id,
    label: model.id,
    meta: `${model.provider} · ${model.price}`,
    current: model.id === currentModel,
  }));
}

// ── Models.dev-synced superset ────────────────────────────────────────────────
//
// The priced catalog is an offline floor, not an allowlist. Cached public
// metadata adds provider-qualified models without requiring a pricing edit.
const PLAN_PROVIDERS: Readonly<Record<string, true>> = {
  kimi: true, qwen: true, "z-ai": true, copilot: true, google: true,
};

/** Byte-order-stable sort used by both the priced and full catalogs. */
function compareCatalogRows(currentModel?: string) {
  return (a: CatalogModel, b: CatalogModel): number => {
    if (a.id === currentModel) return b.id === currentModel ? 0 : -1;
    if (b.id === currentModel) return 1;
    return compareStrings(a.provider, b.provider) || compareStrings(a.id, b.id);
  };
}

/**
 * Models in the cached/offline public catalog beyond the priced floor. Missing
 * prices remain unknown; subscription-plan zeroes are not free API tariffs.
 */
export function catalogExtras(opts: CatalogSyncOptions = {}): CatalogModel[] {
  const priced = new Set(Object.keys(MODEL_PRICING).map((k) => k.toLowerCase()));
  const out: CatalogModel[] = [];
  for (const m of loadCatalogModels(opts).models) {
    // Skip only the priced core's own rows (same id, same provider).
    if (priced.has(m.id.toLowerCase()) && m.provider === modelProvider(m.id)) continue;
    const plan = Object.hasOwn(PLAN_PROVIDERS, m.provider) || (m.provider === "cline" && m.id.startsWith("cline-pass/"));
    let price = m.provider === "cline" && plan ? "ClinePass plan (access unverified)" : plan ? "subscription" : "—";
    if (!plan && m.input !== undefined && m.output !== undefined) {
      const rates = Object.hasOwn(METERED_CATALOG_PROVIDERS, m.provider)
        ? getRates(`${m.provider}/${m.id}`)
        : { input: m.input, output: m.output };
      price = formatModelPrice(rates.input, rates.output);
    }
    out.push({ id: m.id, provider: m.provider, price });
  }
  return out;
}

/**
 * The full picker list: the priced core plus every Models.dev-synced model we
 * don't already price, sorted into one provider-grouped list with the active
 * model floated to the top.
 */
export function buildFullModelCatalog(
  currentModel?: string,
  opts: CatalogSyncOptions = {},
): CatalogModel[] {
  // Cached provider-qualified estimates must be registered before pricing the floor.
  const extras = catalogExtras(opts);
  const priced = buildModelCatalog(currentModel);
  const models = [...priced, ...extras];
  if (currentModel && !models.some((model) => model.id === currentModel)) {
    models.push({ id: currentModel, provider: modelProvider(currentModel), price: "—" });
  }
  return models.sort(compareCatalogRows(currentModel));
}

/**
 * Which rows the picker shows before any filter narrows them. Curated
 * (default) is the priced core; `tab` shows all, and any filter searches all.
 */
export function scopeModelCatalog(
  catalog: CatalogModel[],
  opts: { showAll?: boolean; filter?: string; currentModel?: string } = {},
): CatalogModel[] {
  if (opts.showAll || (opts.filter ?? "").trim().length > 0) return catalog;
  const current = opts.currentModel;
  const curated = buildModelCatalog(current);
  if (current && !curated.some((model) => model.id === current)) {
    const row = catalog.find((model) => model.id === current);
    curated.push(row ?? { id: current, provider: modelProvider(current), price: "—" });
    curated.sort(compareCatalogRows(current));
  }
  return curated;
}
