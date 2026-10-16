import { describe, expect, it } from "vitest";
import {
  formatExecutionMode,
  formatGoal,
  formatTimeCap,
  recommendedScanDepth,
  recommendedScanGoal,
  recommendedTimeCapMs,
} from "./scan-plan.js";

describe("scan plan recommendations", () => {
  it("matches target shape to a conservative security goal", () => {
    expect(recommendedScanGoal("package")).toBe("known-vulnerabilities");
    expect(recommendedScanGoal("source")).toBe("unknown-vulnerabilities");
    expect(recommendedScanGoal("web")).toBe("misconfigurations");
  });

  it("recommends deeper work for unknown-vulnerability research", () => {
    expect(recommendedScanDepth("unknown-vulnerabilities")).toBe("deep");
    expect(recommendedScanDepth("known-vulnerabilities")).toBe("default");
  });

  it("formats operator-facing limits", () => {
    expect(formatGoal("misconfigurations")).toBe("misconfigurations");
    expect(formatExecutionMode("parallel")).toContain("parallel");
    expect(formatTimeCap(600_000)).toBe("10m");
    expect(recommendedTimeCapMs("web", "quick")).toBe(30_000);
  });
});
