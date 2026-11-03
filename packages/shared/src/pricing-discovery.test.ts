import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAndRegisterPricing, resetPricingDiscovery, setPricingDiscoveryFetch } from "./pricing-discovery.js";
import { estimateCost, getRates, hasKnownPricing } from "./pricing.js";

// registerModelPricing adds to a process-wide table with no un-registration API,
// so every test uses a UNIQUE model id — unlike real OpenRouter slugs such as
// z-ai/glm-5.3-flash, none of these normalizations is already bundled.
const PROMPT_PER_TOKEN = "0.0000000125"; // $0.0125/M
const COMPLETION_PER_TOKEN = "0.0000000450"; // $0.045/M
const CACHE_READ_PER_TOKEN = "0.0000000025"; // $0.0025/M
const CONVERTED_RATES = () => ({ input: expect.closeTo(0.0125, 12), output: expect.closeTo(0.045, 12), cachedInput: expect.closeTo(0.0025, 12) });

function catalogPayload(id: string): unknown {
  return {
    data: [
      { id, pricing: { prompt: PROMPT_PER_TOKEN, completion: COMPLETION_PER_TOKEN, input_cache_read: CACHE_READ_PER_TOKEN } },
      { id: `${id}-broken`, pricing: { prompt: "not-a-number", completion: "1" } },
    ],
  };
}

function catalogFetch(id: string, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(catalogPayload(id)), { status }));
}

describe("OpenRouter pricing discovery", () => {
  beforeEach(() => resetPricingDiscovery());
  afterEach(() => resetPricingDiscovery());

  it("registers catalog rates for routed ids under raw and normalized spellings", async () => {
    const routed = "openrouter/acme-labs/novel-99";
    const fetch = catalogFetch("acme-labs/novel-99");
    await discoverAndRegisterPricing(routed, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hasKnownPricing(routed)).toBe(true);
    expect(getRates(routed)).toEqual(CONVERTED_RATES());
    expect(getRates("acme-labs/novel-99")).toEqual(CONVERTED_RATES());
  });

  it("registers the vendor-normalized spelling when only the bare slug is known", async () => {
    const fetch = catalogFetch("acme-labs/novel-98");
    await discoverAndRegisterPricing("acme-labs/novel-98", fetch);
    expect(getRates("openrouter/acme-labs/novel-98")).toEqual(CONVERTED_RATES());
  });

  it("matches catalog ids at an intermediate prefix stage when routing prefixes over-strip", async () => {
    // Real shape: session id "openrouter/z-ai/glm-x", catalog id "z-ai/glm-x" —
    // the fully normalized form ("glm-x") no longer matches the catalog id.
    const fetch = catalogFetch("z-ai/novel-91");
    await discoverAndRegisterPricing("openrouter/z-ai/novel-91", fetch);
    expect(getRates("openrouter/z-ai/novel-91")).toEqual(CONVERTED_RATES());
  });

  it("prices usage at the converted per-million rates", async () => {
    const routed = "openrouter/acme-labs/novel-97";
    const fetch = catalogFetch("acme-labs/novel-97");
    await discoverAndRegisterPricing(routed, fetch);
    // 1M prompt + 1M completion tokens, per-token strings scaled by 1e6.
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, routed)).toBeCloseTo(0.0125 + 0.045, 12);
    // 1M cached-input tokens bill at the catalog's input_cache_read rate (subset of inputTokens).
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, routed)).toBeCloseTo(0.0025, 12);
  });

  it("is a no-op when the id is already priced, without touching the catalog", async () => {
    const fetch = catalogFetch("acme-labs/unused");
    await discoverAndRegisterPricing("openrouter/glm-5.3-flash", fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(getRates("openrouter/glm-5.3-flash")).toEqual(getRates("glm-5.3-flash"));
  });

  it("reuses one catalog fetch for repeated discovery attempts (single-flight)", async () => {
    const fetch = catalogFetch("acme-labs/novel-96");
    await discoverAndRegisterPricing("openrouter/acme-labs/novel-96", fetch);
    await discoverAndRegisterPricing("openrouter/acme-labs/novel-96", fetch);
    await discoverAndRegisterPricing("openrouter/other-acme/novel-96", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never throws when the catalog fetch fails, and retries later", async () => {
    const routed = "openrouter/acme-labs/novel-95";
    const failing = catalogFetch("acme-labs/novel-95", 503);
    await expect(discoverAndRegisterPricing(routed, failing)).resolves.toBeUndefined();
    expect(hasKnownPricing(routed)).toBe(false);
    const working = catalogFetch("acme-labs/novel-95");
    await discoverAndRegisterPricing(routed, working);
    expect(hasKnownPricing(routed)).toBe(true);
  });

  it("never throws when the catalog payload is malformed", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: "garbage" }), { status: 200 }));
    await expect(discoverAndRegisterPricing("openrouter/acme-labs/novel-94", fetch)).resolves.toBeUndefined();
  });

  it("honors a fetch configured through the test seam and clears it on reset", async () => {
    setPricingDiscoveryFetch(catalogFetch("acme-labs/novel-93"));
    await discoverAndRegisterPricing("openrouter/acme-labs/novel-93");
    expect(getRates("openrouter/acme-labs/novel-93")).toEqual(CONVERTED_RATES());
  });
});
