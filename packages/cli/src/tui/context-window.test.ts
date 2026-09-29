import { describe, expect, it } from "vitest";
import { resolveContextLimit } from "./context-window.js";

describe("resolveContextLimit — connected providers", () => {
  const loadModels = () => ({
    source: "synced",
    models: [
      { id: "gpt-5.5", provider: "openai", contextTokens: 200_000 },
      { id: "gpt-5.5", provider: "azure", contextTokens: 300_000 },
    ],
  });

  it("uses the active provider's exact catalog window when model IDs overlap", () => {
    expect(resolveContextLimit({ modelId: "gpt-5.5", providerId: "azure" }, { loadModels }))
      .toEqual({ tokens: 300_000, source: "synced-catalog" });
    expect(resolveContextLimit({ modelId: "gpt-5.5", providerId: "openai" }, { loadModels }))
      .toEqual({ tokens: 200_000, source: "synced-catalog" });
  });

  it("never guesses a window without a running provider", () => {
    expect(resolveContextLimit({ modelId: "gpt-5.5", providerId: undefined }, { loadModels })).toBeNull();
  });
});
