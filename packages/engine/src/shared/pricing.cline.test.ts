import { describe, expect, it } from "vitest";
import { estimateCost, getRates, modelProvider } from "./pricing.js";

describe("Cline pricing and routing identity", () => {
  it("keeps Pass models and gateway-qualified vendor models on the Cline connection", () => {
    expect(modelProvider("cline-pass/glm-5.3")).toBe("cline");
    expect(modelProvider("cline/anthropic/claude-sonnet-4-6")).toBe("cline");
  });
  it("uses exact Pass reference quota rates rather than a direct-provider tariff or free subscription catalog rate", () => {
    expect(getRates("cline-pass/deepseek-v4-flash")).toEqual({ input: 0.44, output: 1.32, cachedInput: 0.014 });
    expect(getRates("cline/cline-pass/deepseek-v4-flash")).toEqual(getRates("cline-pass/deepseek-v4-flash"));
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "cline-pass/deepseek-v4-flash")).toBe(1.76);
  });
});
