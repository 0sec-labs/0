import { describe, it, expect } from "vitest";
import { ToolExecutor } from "./tools.js";

describe("ToolExecutor reliability (0#tool-reliability)", () => {
  it("reports a clean bill of health when nothing degraded", () => {
    const executor = new ToolExecutor({
      target: "https://example.com",
      scanId: "reliability-scan",
      findings: [],
      attackResults: [],
      targetInfo: {},
    }, null);
    expect(executor.toolHealthSummary().total).toBe(0);
    expect(executor.toolHealthSummary().line).toBe("");
  });
});
