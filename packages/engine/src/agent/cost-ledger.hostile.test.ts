import { describe, expect, it } from "vitest";
import { ScanCostLedger } from "./cost-ledger.js";

describe("cost ledger with malformed usage receipts", () => {
  const model = "claude-sonnet-4-6";
  it.each([
    ["NaN", { inputTokens: Number.NaN, outputTokens: 10 }],
    ["Infinity", { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 10 }],
    ["negative", { inputTokens: -5_000_000, outputTokens: 10 }],
    ["NaN cache", { inputTokens: 10, outputTokens: 10, cachedInputTokens: Number.NaN }],
  ])("keeps cumulative cost finite and non-decreasing after %s tokens", (_name, bad) => {
    const ledger = new ScanCostLedger();
    ledger.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, model);
    const before = ledger.totalCostUsd();
    expect(before).toBeGreaterThan(0);
    ledger.add(bad, model);
    const after = ledger.totalCostUsd();
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThanOrEqual(before);
    const usage = ledger.tokenUsage();
    expect(Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)).toBe(true);
  });

  it("does not let a malformed receipt hide spend from a cost ceiling", () => {
    const ledger = new ScanCostLedger();
    ledger.add({ inputTokens: Number.NaN, outputTokens: 0 }, model);
    ledger.add({ inputTokens: 100_000_000, outputTokens: 0 }, model);
    expect(ledger.totalCostUsd() >= 3).toBe(true);
  });

  it("handles huge but finite counts without overflowing to NaN", () => {
    const ledger = new ScanCostLedger();
    ledger.add({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER }, model);
    expect(Number.isFinite(ledger.totalCostUsd())).toBe(true);
  });
});
