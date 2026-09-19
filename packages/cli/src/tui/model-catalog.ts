/**
 * The selectable model list behind `/model`.
 *
 * There is deliberately no second hand-maintained list of models here: the
 * pricing table in @0sec/shared is already the one place that knows which
 * ids the tool understands, and a separate "menu" list would drift from it
 * the first time a model is added. So the catalog is derived — ids from
 * MODEL_PRICING, provider from `modelProvider`, price from `getRates` — and
 * this module only decides ordering and presentation.
 */

import { MODEL_PRICING, getRates, modelProvider } from "@0sec/shared";
import type { InferenceModel } from "@0sec/core";

import type { SelectorItem } from "./selector.js";
import { loadCatalogModels, type CatalogSyncOptions } from "./model-catalog-sync.js";

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
      const rates = getRates(id);
      return { id, provider: modelProvider(id), price: formatModelPrice(rates.input, rates.output) };
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
// `buildModelCatalog` above is the priced core: exactly the ids @0sec/shared
// has rates for, in a stable order. The functions below widen the picker to
// every model the operator's provider offers by folding in the Models.dev
// catalog (cached, with a bundled offline floor — see model-catalog-sync.ts).
// Drop a synced row only when the priced core shows that exact row already.

/** Byte-order-stable sort used by both the priced and full catalogs. */
function compareCatalogRows(currentModel?: string) {
  return (a: CatalogModel, b: CatalogModel): number => {
    if (a.id === currentModel) return b.id === currentModel ? 0 : -1;
    if (b.id === currentModel) return 1;
    return compareStrings(a.provider, b.provider) || compareStrings(a.id, b.id);
  };
}

/**
 * Models present in the cached/offline Models.dev catalog beyond the priced
 * core's own rows. Price is shown only when the feed carried one; otherwise
 * a neutral placeholder, so the operator can still select the model (cost
 * accounting falls back to the `default` rate row, exactly as it does today
 * for any unrecognised id).
 */
export function catalogExtras(opts: CatalogSyncOptions = {}): CatalogModel[] {
  const priced = new Set(Object.keys(MODEL_PRICING).map((k) => k.toLowerCase()));
  const out: CatalogModel[] = [];
  for (const m of loadCatalogModels(opts).models) {
    // Skip only the priced core's own rows (same id, same provider).
    if (priced.has(m.id.toLowerCase()) && m.provider === modelProvider(m.id)) continue;
    const price =
      typeof m.input === "number" && typeof m.output === "number"
        ? formatModelPrice(m.input, m.output)
        : "—";
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
  const priced = buildModelCatalog(currentModel);
  const extras = catalogExtras(opts);
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

// ── Hosted catalogue ──────────────────────────────────────────────────────────
//
// The BYOK catalogue above is derived from the pricing table plus the
// Models.dev sync. The hosted catalogue is a different kind of thing: it is
// the account's OWN model list, fetched from the service that will actually
// run the request (see `loadHostedModelCatalog` in model-catalog-sync.ts), and
// nothing in this section may borrow a BYOK number to fill a hosted gap. A
// hosted id that the service did not describe reads `unknown`.
//
// What the hosted catalogue does NOT carry is any availability, readiness,
// entitlement or qualification signal: canonical `InferenceModel` has no such
// field, and the account response carries only a balance. So this projection
// makes no claim of that kind — not a synthesised reason string and not a
// constant-true flag, because a field that is always true still asserts that
// something was checked. Membership in the list is exactly one fact: the
// service listed this route for this account. Listed rows may be OFFERED for
// explicit operator selection; they are not described as qualified, entitled,
// ready, healthy, verified or funded anywhere in this module.

/** Customer-facing Cloud model capabilities; routing stays in the service catalog. */
export interface HostedCatalogModel {
  id: string;
  /** `context_length` when it is a positive finite number, else null. */
  contextTokens: number | null;
  /** `max_output_tokens` under the same rule. */
  maxOutputTokens: number | null;
}

/**
 * A token count the catalogue actually reported. Zero, a negative, NaN, or a
 * non-number are all "the service did not tell us", which is `null` — never 0
 * and never a floor, because a consumer that renders 0 states a window the
 * service never published.
 */
function hostedTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}


/**
 * Project the account's live catalogue onto rows the picker can draw.
 *
 * Funding remains in the account response, separate from model capabilities.
 *
 * Malformed input is rejected rather than absorbed. A row with a missing or
 * non-string id cannot be selected (there is nothing to send), and two rows
 * sharing an id are two different routes that the picker would silently
 * collapse into one — so both throw. The caller's job is to report the failure;
 * there is deliberately no partial catalogue and no fallback list.
 */
export function buildHostedModelCatalog(models: readonly InferenceModel[]): HostedCatalogModel[] {
  const seen = new Set<string>();
  return models.map((model) => {
    if (!model || typeof model.id !== "string" || model.id.length === 0) {
      throw new Error("Hosted model catalog contains a row with no usable model id");
    }
    if (seen.has(model.id)) {
      throw new Error(`Hosted model catalog contains duplicate model id: ${model.id}`);
    }
    seen.add(model.id);
    return {
      id: model.id,
      contextTokens: hostedTokens(model.context_length),
      maxOutputTokens: hostedTokens(model.max_output_tokens),
    };
  });
}

/**
 * Which hosted row the picker should open on. A highlight only — it never
 * writes a model, a role assignment or a policy.
 *
 * An explicit model is a pin the operator set, so it wins outright: if the
 * pinned id is in the catalogue that row is returned, and if it is NOT, the
 * answer is `undefined`. Substituting a different model for an explicit choice
 * would silently run a model the operator did not pick, which is the worst
 * thing this function could do, so there is no default and no fallback row.
 * `preferredId` is consulted only when nothing is pinned.
 */
export function preferredHostedModel(
  models: readonly HostedCatalogModel[],
  explicitModel: string | undefined,
  preferredId?: string,
): HostedCatalogModel | undefined {
  if (explicitModel !== undefined) return models.find((model) => model.id === explicitModel);
  if (preferredId === undefined) return undefined;
  return models.find((model) => model.id === preferredId);
}

/**
 * The detail column's lines for one hosted row.
 *
 * Only customer model identity and capabilities are shown. Supplier routing and
 * cost metadata stay out of this projection; listing is not a funding guarantee.
 */
export function hostedModelDetails(model: HostedCatalogModel): string[] {
  return [
    model.id,
    `Context: ${model.contextTokens ?? "unknown"} · output limit: ${model.maxOutputTokens ?? "unknown"}`,
  ];
}
