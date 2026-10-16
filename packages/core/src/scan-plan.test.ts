import { describe, expect, it, vi } from "vitest";
import type { ScanPlan, ScanReport } from "@0/shared";
import { getRates } from "@0/shared";
import { ScanCostLedger } from "./agent/cost-ledger.js";
import { executeScanPlan } from "./scan-plan.js";

const plan: ScanPlan = { goal: "unknown-vulnerabilities", depth: "quick", runCount: 3, executionMode: "sequential", timeCapMs: 1_000, costCapUsd: 10 };
function emptyReport(): ScanReport {
  return { target: "fixture", scanDepth: "quick", startedAt: "", completedAt: "", durationMs: 0,
    summary: { totalAttacks: 0, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], warnings: [] };
}

describe("scan plan execution", () => {
  it("retains a rejected attempt between clean runs instead of reporting an unqualified success", async () => {
    const result = await executeScanPlan({ plan, emptyReport, emitTerminalEvent: false,
      dispatch: async ({ runIndex }) => {
        if (runIndex === 2) throw new Error("provider unavailable");
        return emptyReport();
      },
    });
    expect(result.attempts?.map(attempt => [attempt.runIndex, attempt.status])).toEqual([[1, "completed"], [2, "rejected"], [3, "completed"]]);
    expect(result.attempts?.[1]?.error).toBe("provider unavailable");
    expect(result.completedRuns).toBe(2);
    expect(result.executionSuccessful).toBe(false);
    expect(result.exitReason).toBe("partial");
  });

  it("attributes overlapping runs independently while charging one mixed-model root ledger", async () => {
    const ledger = new ScanCostLedger();
    ledger.add({ inputTokens: 500, outputTokens: 100 }, "gpt-4o");
    const priorCost = ledger.totalCostUsd();
    const expected = new ScanCostLedger();
    const models = ["gpt-4o", "claude-sonnet-4-20250514", "gpt-4o"];
    const perRun = models.map((model, index) => {
      const usage = { inputTokens: 1_000 * (index + 1), outputTokens: 100 };
      expected.add(usage, model);
      const own = new ScanCostLedger();
      own.add(usage, model);
      return { model, usage, costUsd: own.totalCostUsd() };
    });
    const { promise: allEntered, resolve } = Promise.withResolvers<void>();
    let entered = 0;
    const result = await executeScanPlan({ plan: { ...plan, executionMode: "parallel" }, ledger, emptyReport, emitTerminalEvent: false,
      dispatch: async ({ runIndex, ledger: runLedger }) => {
        const run = perRun[runIndex - 1]!;
        runLedger.add(run.usage, run.model);
        if (++entered === 3) resolve();
        await allEntered;
        return emptyReport();
      },
    });
    result.attempts?.forEach((attempt, index) => expect(attempt.costUsd).toBeCloseTo(perRun[index]!.costUsd, 10));
    expect(result.estimatedCostUsd).toBeCloseTo(expected.totalCostUsd(), 10);
    expect(ledger.totalCostUsd() - priorCost).toBeCloseTo(expected.totalCostUsd(), 10);
    expect(result.completedRuns).toBe(3);
  });

  it("stops further attempts when normalized cache writes exceed the shared tariff cap", async () => {
    const model = "claude-sonnet-4-20250514";
    const cap = getRates(model).input * 1_000 / 1_000_000 * 1.1;
    let dispatched = 0;
    const result = await executeScanPlan({ plan: { ...plan, costCapUsd: cap }, emptyReport, emitTerminalEvent: false,
      dispatch: async ({ ledger }) => {
        dispatched++;
        ledger.add({ inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 1_000 }, model);
        return emptyReport();
      },
    });
    expect(dispatched).toBe(1);
    expect(result.costCeilingExceeded).toBe(true);
    expect(result.attempts?.map(attempt => attempt.status)).toEqual(["cost_ceiling_exceeded", "cost_ceiling_exceeded", "cost_ceiling_exceeded"]);
    expect(result.estimatedCostUsd).toBeCloseTo(getRates(model).input * 1_000 / 1_000_000 * 1.25, 10);
  });

  it("cancels an in-flight attempt at the wall-clock deadline and accounts for every undispatched attempt", async () => {
    vi.useFakeTimers();
    try {
      let dispatched = 0;
      let cancelled = false;
      const pending = executeScanPlan({ plan: { ...plan, timeCapMs: 30 }, emptyReport, emitTerminalEvent: false,
        dispatch: async ({ signal }) => {
          dispatched++;
          const { promise, resolve } = Promise.withResolvers<void>();
          signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
          await promise;
          return emptyReport();
        },
      });
      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;
      expect(cancelled).toBe(true);
      expect(dispatched).toBe(1);
      expect(result.attempts?.map(attempt => attempt.status)).toEqual(["time_cap_exceeded", "time_cap_exceeded", "time_cap_exceeded"]);
      expect(result.completedRuns).toBe(0);
      expect(result.executionSuccessful).toBe(false);
      expect(result.exitReason).toBe("time_cap_exceeded");
    } finally {
      vi.useRealTimers();
    }
  });
});
