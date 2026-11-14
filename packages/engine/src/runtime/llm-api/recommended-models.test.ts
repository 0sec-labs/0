import { describe, expect, it } from "vitest";
import { recommendModels } from "./recommended-models.js";

describe("recommendModels", () => {
  it("picks the first reachable candidate per role and prefers direct providers", () => {
    const picks = recommendModels([
      { id: "gpt-6-luna", provider: "azure" }, { id: "gpt-6-luna", provider: "openai" },
      { id: "DeepSeek-V4-Flash", provider: "azure" }, { id: "gpt-5.6-sol", provider: "azure" },
    ]);
    const by = Object.fromEntries(picks.map(pick => [pick.role, `${pick.providerId}:${pick.model}`]));
    expect(by).toEqual({ orchestrator: "openai:gpt-6-luna", scanner: "openai:gpt-6-luna", exploit: "azure:gpt-5.6-sol", summariser: "azure:DeepSeek-V4-Flash" });
  });
  it("skips disabled rows and unknown models", () => {
    expect(recommendModels([{ id: "gpt-6-luna", provider: "openai", enabled: false }, { id: "mystery", provider: "openai" }])).toEqual([]);
  });
});
