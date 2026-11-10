import { describe, expect, it } from "vitest";
import { getRates, hasKnownPricing, modelNormalizationStages, modelProvider, normalizeModel, registerModelPricing } from "./pricing.js";

describe("Together AI pricing and routing identity", () => {
  it("attributes a together/-prefixed id to the Together connection", () => {
    expect(modelProvider("together/openai/gpt-oss-120b")).toBe("together");
    expect(modelProvider("together/meta-llama/Llama-3.3-70B-Instruct-Turbo")).toBe("together");
    expect(modelProvider("TOGETHER/Qwen/Qwen3.5-9B")).toBe("together");
  });

  it("does not claim bare vendor ids, which belong to their own families", () => {
    expect(modelProvider("Qwen/Qwen3.5-9B")).not.toBe("together");
    expect(modelProvider("zai-org/GLM-5.3")).not.toBe("together");
  });

  it("strips the routing prefix progressively so catalog and bundled rates resolve", () => {
    expect(modelNormalizationStages("together/openai/gpt-oss-120b")).toEqual(["together/openai/gpt-oss-120b", "openai/gpt-oss-120b", "gpt-oss-120b"]);
    expect(normalizeModel("together/openai/gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(getRates("together/openai/gpt-oss-120b")).toEqual(getRates("gpt-oss-120b"));
    expect(hasKnownPricing("together/openai/gpt-oss-120b")).toBe(true);
  });

  it("prefers an exact discovered rate for the routed id over a generic family rate", () => {
    expect(registerModelPricing("together/synthetic-org/Together-Only-9B", { input: 0.17, output: 0.25, cachedInput: 0.03 })).toBe(true);
    expect(getRates("together/synthetic-org/Together-Only-9B")).toEqual({ input: 0.17, output: 0.25, cachedInput: 0.03 });
    expect(hasKnownPricing("together/synthetic-org/Together-Only-9B")).toBe(true);
  });
});
