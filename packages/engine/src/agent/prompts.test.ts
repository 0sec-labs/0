import { describe, expect, it } from "vitest";
import { buildAuthPromptBlock } from "./prompts.js";

describe("buildAuthPromptBlock", () => {
  it("keeps every credential shape out of model-visible instructions", () => {
    const configs = [
      { type: "bearer" as const, token: "bearer-secret-canary" },
      { type: "cookie" as const, value: "session=cookie-secret-canary" },
      { type: "basic" as const, username: "user-canary", password: "basic-secret-canary" },
      { type: "header" as const, name: "X-Api-Key", value: "header-secret-canary" },
    ];

    for (const config of configs) {
      const prompt = buildAuthPromptBlock(config);
      expect(prompt).toContain("Authenticated requests are configured");
      expect(prompt).not.toContain("bearer-secret-canary");
      expect(prompt).not.toContain("cookie-secret-canary");
      expect(prompt).not.toContain("user-canary");
      expect(prompt).not.toContain("basic-secret-canary");
      expect(prompt).not.toContain("header-secret-canary");
    }
  });
});
