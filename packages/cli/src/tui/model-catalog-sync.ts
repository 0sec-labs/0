/**
 * Models.dev catalog sync with a cached-with-offline-fallback strategy.
 *
 * The `/model` picker (model-catalog.ts) is derived from the hand-priced table
 * in @0/shared — authoritative for cost, but narrow. This module widens the
 * picker with published Models.dev metadata for connected provider routes,
 * without treating that public feed as subscription entitlement or making a
 * live network call:
 *
 *   1. `syncModelCatalog()` fetches Models.dev, normalizes it, and writes a
 *      cache to `~/.0/model-catalog.json`. It NEVER throws — on any failure
 *      (offline, timeout, bad JSON) it returns null and leaves the cache as-is.
 *   2. `loadCatalogModels()` is synchronous and safe to call on the render
 *      path: it returns the freshest thing available — a fresh cache if within
 *      TTL, an expired cache if that's all we have, else the bundled offline
 *      snapshot. It too never throws.
 *
 * So the picker opens instantly off cache/offline data, and a fire-and-forget
 * `syncModelCatalog()` refreshes it for next time. Everything is injectable
 * (fetch, cache path, clock) so it is fully testable without a network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeStateDir, modelProvider, registerModelPricing } from "@0/shared";
import { OFFLINE_MODEL_CATALOG } from "./model-catalog.offline.js";

/** One normalized catalog entry. Prices are $/1M tokens when known. */
export interface SyncedModel {
  id: string;
  provider: string;
  /** Context window in tokens, when the feed reports it. */
  contextTokens?: number;
  input?: number;
  output?: number;
  cachedInput?: number;
}

/** On-disk cache envelope. */
export interface CatalogCache {
  /** Epoch millis the cache was written. */
  fetchedAt: number;
  /** Where the rows came from — the URL, or "offline" for the bundled floor. */
  source: string;
  models: SyncedModel[];
}

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const CATALOG_CACHE_FILENAME = "model-catalog.json";
/** Refresh once a day — matches the pricing-feed cadence. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

// Only aliases for the runtime's actual backends. PAYG Moonshot/Alibaba rows
// must not become models for the distinct Kimi coding / Qwen Token Plan routes.
const CATALOG_PROVIDER_IDS: Readonly<Record<string, string>> = {
  "alibaba-token-plan": "qwen",
  "kimi-code-plan-cn": "kimi",
  "github-copilot": "copilot",
  zai: "z-ai",
};
export const METERED_CATALOG_PROVIDERS: Readonly<Record<string, true>> = {
  anthropic: true, openai: true, deepseek: true, openrouter: true, xai: true, opencode: true,
};

function catalogId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s\x00-\x1f\x7f-\x9f]/.test(value);
}

function finiteRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function contextTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Apply the same trust boundary to network metadata and an old disk cache. */
function normalizedModel(value: unknown): SyncedModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!catalogId(row.id) || !catalogId(row.provider) || row.provider === "chatgpt-codex") return null;
  const provider = Object.hasOwn(CATALOG_PROVIDER_IDS, row.provider)
    ? CATALOG_PROVIDER_IDS[row.provider] ?? row.provider
    : row.provider;
  const model: SyncedModel = {
    id: row.id,
    provider,
    ...(finiteRate(row.input) ? { input: row.input } : {}),
    ...(finiteRate(row.output) ? { output: row.output } : {}),
    ...(finiteRate(row.cachedInput) ? { cachedInput: row.cachedInput } : {}),
    ...(contextTokens(row.contextTokens) ? { contextTokens: row.contextTokens } : {}),
  };
  if (Object.hasOwn(METERED_CATALOG_PROVIDERS, provider) && model.input !== undefined && model.output !== undefined) {
    const rates = { input: model.input, output: model.output, cachedInput: model.cachedInput };
    registerModelPricing(`${provider}/${model.id}`, rates);
    if (provider === modelProvider(model.id)) registerModelPricing(model.id, rates);
  }
  return model;
}

export interface CatalogSyncOptions {
  /** Injectable fetch — defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Override the cache file path (defaults to ~/.0/model-catalog.json). */
  cachePath?: string;
  /** Injectable clock for TTL math — defaults to Date.now. */
  now?: () => number;
  /** Catalog source URL — defaults to Models.dev. */
  url?: string;
  /** TTL for freshness decisions — defaults to one day. */
  ttlMs?: number;
}

/** Resolve the cache path, honoring an explicit override then ~/.0. */
export function catalogCachePath(opts: CatalogSyncOptions = {}): string {
  return opts.cachePath ?? join(homeStateDir(), CATALOG_CACHE_FILENAME);
}

/**
 * Normalize the Models.dev `api.json` shape into `SyncedModel[]`.
 *
 * Models.dev is keyed by provider id; each provider carries a `models` object
 * keyed by model id, each model optionally carrying `cost.{input,output}` and
 * `limit.context`. We parse defensively — the feed evolves, and a shape change
 * must degrade to "fewer rows," never a throw.
 *
 * Keeps one row per provider listing: the same id is often served by several
 * gateways.
 */
export function normalizeModelsDev(raw: unknown): SyncedModel[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const out: SyncedModel[] = [];

  for (const [providerId, providerVal] of Object.entries(raw as Record<string, unknown>)) {
    if (!catalogId(providerId) || typeof providerVal !== "object" || providerVal === null || Array.isArray(providerVal)) continue;
    const models = (providerVal as Record<string, unknown>)["models"];
    if (typeof models !== "object" || models === null || Array.isArray(models)) continue;

    for (const [modelId, modelVal] of Object.entries(models as Record<string, unknown>)) {
      if (!catalogId(modelId) || typeof modelVal !== "object" || modelVal === null || Array.isArray(modelVal)) continue;
      const m = modelVal as Record<string, unknown>;

      const cost = (typeof m["cost"] === "object" && m["cost"] !== null
        ? (m["cost"] as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const limit = (typeof m["limit"] === "object" && m["limit"] !== null
        ? (m["limit"] as Record<string, unknown>)
        : {}) as Record<string, unknown>;

      const entry = normalizedModel({
        id: modelId,
        provider: providerId,
        input: cost["input"],
        output: cost["output"],
        cachedInput: cost["cache_read"],
        contextTokens: limit["context"],
      });
      if (entry) out.push(entry);
    }
  }
  return out;
}

function readCache(path: string): CatalogCache | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as CatalogCache).models) ||
      !Number.isFinite((parsed as CatalogCache).fetchedAt) ||
      (parsed as CatalogCache).fetchedAt < 0 ||
      typeof (parsed as CatalogCache).source !== "string"
    ) {
      return null;
    }
    const cache = parsed as CatalogCache;
    const models = cache.models.flatMap((row) => {
      const model = normalizedModel(row);
      return model ? [model] : [];
    });
    return { fetchedAt: cache.fetchedAt, source: cache.source, models };
  } catch {
    return null;
  }
}

function writeCache(path: string, cache: CatalogCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // Best effort: an unwritable cache dir just means we re-fetch next time.
  }
}

/** True when the cache exists and is within TTL. */
export function isCacheFresh(cache: CatalogCache | null, opts: CatalogSyncOptions = {}): boolean {
  if (!cache) return false;
  const now = (opts.now ?? Date.now)();
  const ttl = opts.ttlMs ?? CATALOG_TTL_MS;
  const age = now - cache.fetchedAt;
  return Number.isFinite(age) && age >= 0 && age < ttl;
}

/**
 * Return the best catalog available *without* touching the network. Freshness
 * order: fresh cache → any cache (even expired) → bundled offline snapshot.
 * Synchronous and total — safe on the render path.
 */
export function loadCatalogModels(opts: CatalogSyncOptions = {}): CatalogCache {
  const cache = readCache(catalogCachePath(opts));
  if (cache && cache.models.length > 0) return cache;
  return { fetchedAt: 0, source: "offline", models: OFFLINE_MODEL_CATALOG };
}

/**
 * Refresh the catalog from Models.dev and write the cache. Returns the new
 * cache on success, or null on any failure (never throws). If `force` is false
 * (default) and the cache is already fresh, returns the existing cache without
 * a network call so `/model` can call this unconditionally on open.
 */
export async function syncModelCatalog(
  opts: CatalogSyncOptions & { force?: boolean } = {},
): Promise<CatalogCache | null> {
  const path = catalogCachePath(opts);
  const existing = readCache(path);
  if (!opts.force && isCacheFresh(existing, opts) && (existing?.models.length ?? 0) > 0) {
    return existing;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const url = opts.url ?? MODELS_DEV_URL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    const models = normalizeModelsDev(json);
    if (models.length === 0) return null;
    const cache: CatalogCache = {
      fetchedAt: (opts.now ?? Date.now)(),
      source: url,
      models,
    };
    writeCache(path, cache);
    return cache;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
