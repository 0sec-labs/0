import { describe, expect, it } from "vitest";
import {
  createScanPlan,
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

  it("keeps plan values explicit and formats operator-facing limits", () => {
    const plan = createScanPlan({
      goal: "misconfigurations",
      depth: "default",
      runCount: 2,
      executionMode: "parallel",
      timeCapMs: 600_000,
      costCapUsd: 5,
    });
    expect(plan).toEqual({
      goal: "misconfigurations",
      depth: "default",
      runCount: 2,
      executionMode: "parallel",
      timeCapMs: 600_000,
      costCapUsd: 5,
    });
    expect(formatGoal(plan.goal)).toBe("misconfigurations");
    expect(formatExecutionMode(plan.executionMode)).toContain("parallel");
    expect(formatTimeCap(plan.timeCapMs)).toBe("10m");
    expect(recommendedTimeCapMs("web", "quick")).toBe(30_000);
  });
});
