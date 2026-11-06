import { describe, expect, it } from "vitest";
import { auditAgentPrompt, reviewAgentPrompt } from "./analysis-prompts.js";

describe("evidence-driven investigation prompts", () => {
  it("continues audit and deep review without invented turn or tool allowances", () => {
    for (const prompt of [
      auditAgentPrompt("example", "1.0.0", "/source", [], []),
      reviewAgentPrompt("/source", [], undefined, false, "Inspect authentication"),
    ]) {
      expect(prompt).not.toMatch(/~30 tool calls|~20 turns|final ~5 calls|CALL `done` IMMEDIATELY|60% of your turns/);
      expect(prompt).toContain("Saving");
      expect(prompt).toContain("not a reason to stop");
      expect(prompt).toMatch(/Batch independent/i);
      expect(prompt).toMatch(/explicit operator\s+limits/);
    }
  });
});
