import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_MODELS } from "./llm-api/provider-detect.js";
import { estimateCost, hasKnownPricing } from "../shared/pricing.js";

// A default model with no price makes the per-run cost ceiling unenforceable, so every default we
// ship for a metered provider must resolve to a price.
describe("default models are priced", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 };
  for (const provider of ["openai", "anthropic", "openrouter", "xai", "chatgpt-codex"] as const) {
    it(`${provider} default has a price`, () => {
      const model = DEFAULT_PROVIDER_MODELS[provider];
      expect(model, `${provider} must have a default`).toBeTruthy();
      const priced = model!;
      expect(hasKnownPricing(priced), `${priced} is unpriced`).toBe(true);
      expect(estimateCost(usage, priced)).toBeGreaterThan(0);
    });
  }
});
