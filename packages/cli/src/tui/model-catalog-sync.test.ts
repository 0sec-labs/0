import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeModelsDev,
  syncModelCatalog,
  loadCatalogModels,
  isCacheFresh,
  CATALOG_TTL_MS,
  type CatalogCache,
} from "./model-catalog-sync.js";
import { catalogExtras, buildFullModelCatalog, buildModelCatalog } from "./model-catalog.js";
import { getRates, registerModelPricing } from "@0/shared";
import { reachableModelCatalog } from "./model-layout.js";
import { providerStates } from "./provider-status.js";

/** Minimal Models.dev-shaped payload: provider → { models: { id → {cost,limit} } }. */
const MODELS_DEV_SAMPLE = {
  anthropic: {
    models: {
      "claude-opus-4-7": { cost: { input: 5, output: 25 }, limit: { context: 200000 } },
      "some-unpriced-model": { cost: { input: 1, output: 2 }, limit: { context: 128000 } },
    },
  },
  openai: {
    models: {
      "gpt-brand-new": {}, // no cost/limit → still a valid catalog row
    },
  },
  junkProvider: null, // defensive: must be skipped, not throw
};

function fakeFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      json: async () => payload,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("normalizeModelsDev", () => {
  it("flattens provider→models into rows, tolerating junk", () => {
    const rows = normalizeModelsDev(MODELS_DEV_SAMPLE);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["claude-opus-4-7", "gpt-brand-new", "some-unpriced-model"]);

    const unpriced = rows.find((r) => r.id === "some-unpriced-model")!;
    expect(unpriced.provider).toBe("anthropic");
    expect(unpriced.input).toBe(1);
    expect(unpriced.contextTokens).toBe(128000);

    const bare = rows.find((r) => r.id === "gpt-brand-new")!;
    expect(bare.input).toBeUndefined();
    expect(bare.contextTokens).toBeUndefined();
  });

  it("keeps the same id listed by several providers (no cross-provider collapse)", () => {
    const rows = normalizeModelsDev({
      kilo: { models: { "openrouter/auto": { cost: { input: 1, output: 2 } } } },
      openrouter: { models: { "openrouter/auto": { cost: { input: 0, output: 0 } } } },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(["kilo", "openrouter"]));
  });

  it("returns [] for non-object / malformed input rather than throwing", () => {
    expect(normalizeModelsDev(null)).toEqual([]);
    expect(normalizeModelsDev("nope")).toEqual([]);
    expect(normalizeModelsDev({ p: { models: 42 } })).toEqual([]);
  });

  it("keeps unsafe metadata unknown and never imports public Codex entitlement", () => {
    expect(normalizeModelsDev({
      openai: { models: {
        "new-safe-model": { cost: { input: Infinity, output: -1, cache_read: NaN }, limit: { context: 0.5 } },
        "bad\nmodel": {},
      } },
      "chatgpt-codex": { models: { "public-only-subscription": {} } },
    })).toEqual([{ id: "new-safe-model", provider: "openai" }]);
  });

  it("maps only the matching coding backends, not their separate PAYG catalogs", () => {
    const rows = normalizeModelsDev({
      "alibaba-token-plan": { models: { "future-qwen": {} } },
      alibaba: { models: { "payg-only-qwen": {} } },
      "kimi-code-plan-cn": { models: { "future-kimi": {} } },
      moonshotai: { models: { "payg-only-kimi": {} } },
      "github-copilot": { models: { "future-copilot": {} } },
    });
    const env = { QWEN_API_KEY: "synthetic", KIMI_API_KEY: "synthetic", ZERO_COPILOT_GITHUB_TOKEN: "synthetic" };
    const catalog = rows.map((row) => ({ ...row, price: "subscription" }));
    expect(reachableModelCatalog(catalog, providerStates(env), { env }).map(({ id, provider }) => ({ id, provider })))
      .toEqual([
        { id: "future-qwen", provider: "qwen" },
        { id: "future-kimi", provider: "kimi" },
        { id: "future-copilot", provider: "copilot" },
      ]);
  });
});

describe("syncModelCatalog + cache", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "0-catalog-"));
    cachePath = join(dir, "model-catalog.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fetches, normalizes, and writes a 0600 cache", async () => {
    const cache = await syncModelCatalog({
      fetchImpl: fakeFetch(MODELS_DEV_SAMPLE),
      cachePath,
      now: () => 1000,
    });
    expect(cache).not.toBeNull();
    expect(cache!.models.length).toBe(3);
    expect(cache!.fetchedAt).toBe(1000);
    expect(existsSync(cachePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(cachePath, "utf8")) as CatalogCache;
    expect(onDisk.models.length).toBe(3);
  });

  it("skips the network when the cache is fresh, refetches when forced", async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls++;
      return { ok: true, json: async () => MODELS_DEV_SAMPLE } as unknown as Response;
    }) as unknown as typeof fetch;

    await syncModelCatalog({ fetchImpl: counting, cachePath, now: () => 1000 });
    expect(calls).toBe(1);
    // Fresh cache (same clock) → no second fetch.
    await syncModelCatalog({ fetchImpl: counting, cachePath, now: () => 1000 });
    expect(calls).toBe(1);
    // force bypasses freshness.
    await syncModelCatalog({ fetchImpl: counting, cachePath, now: () => 1000, force: true });
    expect(calls).toBe(2);
  });

  it("returns null and preserves the cache on fetch failure", async () => {
    await syncModelCatalog({ fetchImpl: fakeFetch(MODELS_DEV_SAMPLE), cachePath, now: () => 1000 });
    const failing: typeof fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await syncModelCatalog({ fetchImpl: failing, cachePath, now: () => 9e12, force: true });
    expect(result).toBeNull();
    // Old cache still intact.
    expect(loadCatalogModels({ cachePath }).models.length).toBe(3);
  });

  it("returns null on a non-ok HTTP response", async () => {
    const result = await syncModelCatalog({
      fetchImpl: fakeFetch(MODELS_DEV_SAMPLE, false),
      cachePath,
    });
    expect(result).toBeNull();
  });

  it("makes a novel API model reachable with published cache pricing and preserves it offline", async () => {
    const id = "gpt-automatic-discovery-fixture";
    await syncModelCatalog({
      cachePath,
      fetchImpl: fakeFetch({ openai: { models: {
        [id]: { cost: { input: 1.25, output: 7.5, cache_read: 0.125 }, limit: { context: 524288 } },
      } } }),
      now: () => 1000,
    });
    const env = { OPENAI_API_KEY: "synthetic-key" };
    const selectable = () => reachableModelCatalog(buildFullModelCatalog(undefined, { cachePath }), providerStates(env), { env });
    expect(selectable()).toContainEqual({ id, provider: "openai", price: "$1.25/7.5 per M" });
    expect(getRates(id)).toEqual({ input: 1.25, output: 7.5, cachedInput: 0.125 });
    expect(getRates(`openai/${id}`)).toEqual({ input: 1.25, output: 7.5, cachedInput: 0.125 });
    await syncModelCatalog({ cachePath, force: true, fetchImpl: fakeFetch({}, false) });
    expect(selectable()).toContainEqual({ id, provider: "openai", price: "$1.25/7.5 per M" });
    expect(loadCatalogModels({ cachePath }).models[0]?.contextTokens).toBe(524288);
  });
});

describe("loadCatalogModels fallback order", () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "0-catalog-"));
    cachePath = join(dir, "model-catalog.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the bundled offline floor when no cache exists", () => {
    const loaded = loadCatalogModels({ cachePath });
    expect(loaded.source).toBe("offline");
    expect(loaded.models.length).toBeGreaterThan(0);
  });

  it("prefers an on-disk cache over the offline floor", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: 5, source: "test", models: [{ id: "x", provider: "p" }] }),
    );
    const loaded = loadCatalogModels({ cachePath });
    expect(loaded.source).toBe("test");
    expect(loaded.models).toEqual([{ id: "x", provider: "p" }]);
  });

  it("sanitizes old cached metadata before presenting or pricing it", () => {
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: 5,
      source: "old-cache",
      models: [
        { id: "safe-new-id", provider: "openai", input: -5, output: null, contextTokens: 0.25 },
        { id: "bad\u001bmodel", provider: "openai" },
        { id: "unverified-subscription", provider: "chatgpt-codex" },
      ],
    }));
    expect(loadCatalogModels({ cachePath }).models).toEqual([{ id: "safe-new-id", provider: "openai" }]);
    expect(catalogExtras({ cachePath })).toEqual([{ id: "safe-new-id", provider: "openai", price: "—" }]);
  });

  it("isCacheFresh respects the TTL", () => {
    const cache: CatalogCache = { fetchedAt: 0, source: "s", models: [{ id: "x", provider: "p" }] };
    expect(isCacheFresh(cache, { now: () => CATALOG_TTL_MS - 1 })).toBe(true);
    expect(isCacheFresh(cache, { now: () => CATALOG_TTL_MS + 1 })).toBe(false);
    expect(isCacheFresh({ ...cache, fetchedAt: CATALOG_TTL_MS }, { now: () => 0 })).toBe(false);
    expect(isCacheFresh(null)).toBe(false);
  });
});

describe("catalog merge (priced core + synced extras)", () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "0-catalog-"));
    cachePath = join(dir, "model-catalog.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drops synced models the pricing table already covers, keeps novel ones", () => {
    // Cache has one already-priced id and one novel id.
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: 0,
        source: "test",
        models: [
          { id: "claude-opus-4-7", provider: "anthropic", input: 5, output: 25 }, // priced already
          { id: "totally-new-model", provider: "acme", input: 1, output: 2 },
        ],
      }),
    );
    const extras = catalogExtras({ cachePath });
    const ids = extras.map((e) => e.id);
    expect(ids).toContain("totally-new-model");
    expect(ids).not.toContain("claude-opus-4-7");
    expect(extras.find((e) => e.id === "totally-new-model")!.price).toBe("$1/2 per M");
  });

  it("keeps a priced id offered by another provider, drops the canonical duplicate", () => {
    // A priced id listed by another provider stays; the canonical duplicate goes.
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: 0,
        source: "test",
        models: [
          { id: "qwen3.7-max", provider: "opencode-go", input: 2.5, output: 7.5 },
          { id: "qwen3.7-max", provider: "qwen", input: 2.5, output: 7.5 },
        ],
      }),
    );
    const extras = catalogExtras({ cachePath });
    expect(extras.map((e) => e.provider)).toEqual(["opencode-go"]);
  });

  it("shows the same provider-qualified tariffs used for native and gateway estimates", () => {
    const id = "gpt-5.5";
    const nativeRates = getRates(id);
    const priorOpenaiRates = getRates(`openai/${id}`);
    const priorGatewayRates = getRates(`openrouter/${id}`);
    try {
      writeFileSync(cachePath, JSON.stringify({
        fetchedAt: 5,
        source: "provider-tariffs",
        models: [
          { id, provider: "openai", input: 6, output: 31 },
          { id, provider: "openrouter", input: 11, output: 51 },
        ],
      }));
      const full = buildFullModelCatalog(undefined, { cachePath });
      expect(full.find((row) => row.id === id && row.provider === "openai")?.price).toBe("$6/31 per M");
      expect(full.find((row) => row.id === id && row.provider === "openrouter")?.price).toBe("$11/51 per M");
      expect(getRates(`openai/${id}`)).toEqual({ input: 6, output: 31 });
      expect(getRates(`openrouter/${id}`)).toEqual({ input: 11, output: 51 });
      expect(getRates(id)).toEqual(nativeRates);
    } finally {
      registerModelPricing(`openai/${id}`, priorOpenaiRates);
      registerModelPricing(`openrouter/${id}`, priorGatewayRates);
    }
  });

  it("full catalog is a superset of the priced catalog", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: 0,
        source: "test",
        models: [{ id: "novel-xyz", provider: "acme" }],
      }),
    );
    const priced = buildModelCatalog();
    const full = buildFullModelCatalog(undefined, { cachePath });
    expect(full.length).toBe(priced.length + 1);
    expect(full.some((m) => m.id === "novel-xyz")).toBe(true);
    // Rate-less synced row shows a neutral placeholder, still selectable.
    expect(full.find((m) => m.id === "novel-xyz")!.price).toBe("—");
  });

  it("floats the active model to the top even when it is a synced-only id", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: 0,
        source: "test",
        models: [{ id: "novel-xyz", provider: "acme" }],
      }),
    );
    const full = buildFullModelCatalog("novel-xyz", { cachePath });
    expect(full[0].id).toBe("novel-xyz");
  });

  it("keeps a custom active deployment selectable when absent from the catalog", () => {
    const full = buildFullModelCatalog("custom-deployment-x", { cachePath });
    expect(full[0].id).toBe("custom-deployment-x");
    expect(full[0].price).toBe("—");
    expect(full.filter((model) => model.id === "custom-deployment-x")).toHaveLength(1);
  });
});
