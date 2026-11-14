import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ScanCostLedger, addRuntimeUsage } from "./cost-ledger.js";
import { estimateCost } from "./cost.js";
import { runNativeAgentLoop } from "./native-loop.js";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";

afterEach(() => { vi.unstubAllEnvs(); });

it("settles concurrent billed responses once and stops subsequent calls after the shared ceiling", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  const ledger = new ScanCostLedger();
  const model = "gpt-5.6-sol";
  const usage = { inputTokens: 1000, outputTokens: 0 };
  const ceiling = estimateCost(usage, model) / 2;
  let active = 0, peak = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executeNative = vi.fn(async (): Promise<NativeRuntimeResult> => {
    peak = Math.max(peak, ++active);
    if (active === 3) release();
    await gate;
    active--;
    const result: NativeRuntimeResult = { content: [{ type: "text", text: "fixture response" }], stopReason: "end_turn", durationMs: 0, usage };
    // Mirrors the real runtime wrapper observing the response before its loop.
    addRuntimeUsage(ledger, result, model);
    return result;
  });
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative };
  const states = await Promise.all(Array.from({ length: 3 }, () => runNativeAgentLoop({
    config: { role: "discovery", systemPrompt: "fixture", tools: [], maxTurns: 3,
      target: "https://example.test", scanId: randomUUID(), costModel: model, costLedger: ledger, costCeilingUsd: ceiling },
    runtime, db: null,
  })));
  expect(peak).toBe(3);
  expect(executeNative).toHaveBeenCalledTimes(3);
  expect(states.every(state => state.costCeilingExceeded)).toBe(true);
  expect(ledger.tokenUsage()).toMatchObject({ inputTokens: 3000, outputTokens: 0 });
  expect(ledger.totalCostUsd()).toBeCloseTo(estimateCost(usage, model) * 3);
  // The estimate is a stopping threshold, not a reservation/hard billing cap:
  // requests already in flight are all charged and remain visible.
  expect(ledger.totalCostUsd()).toBeGreaterThan(ceiling);
}, 10_000);
