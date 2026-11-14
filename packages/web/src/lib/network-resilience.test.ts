import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error";
import { createOutageTracker, isTransientMessage, isTransientNetworkError, TransientNetworkError, withTransientRetry } from "./network-resilience";

describe("isTransientNetworkError", () => {
  it("treats dropped fetches and gateway statuses as transient", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(new TypeError("Load failed"))).toBe(true);
    for (const status of [0, 502, 503, 504]) expect(isTransientNetworkError(new ApiError("x", status))).toBe(true);
    expect(isTransientNetworkError(new DOMException("t", "TimeoutError"))).toBe(true);
  });
  it("never retries cancellations or real API errors", () => {
    expect(isTransientNetworkError(new DOMException("a", "AbortError"))).toBe(false);
    for (const status of [400, 401, 403, 404, 500]) expect(isTransientNetworkError(new ApiError("x", status))).toBe(false);
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
    expect(isTransientNetworkError(new TypeError("x is not a function"))).toBe(false);
  });
  it("detects string errors", () => { expect(isTransientMessage("Failed to fetch")).toBe(true); expect(isTransientMessage("Not found")).toBe(false); });
});

describe("withTransientRetry", () => {
  it("retries with the configured backoff then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const result = await withTransientRetry(async () => { if (++calls < 3) throw new TypeError("Failed to fetch"); return "ok"; }, { sleep });
    expect(result).toBe("ok");
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000]);
  });
  it("gives up after three retries with a friendly error", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(withTransientRetry(run, { sleep })).rejects.toBeInstanceOf(TransientNetworkError);
    expect(run).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.reduce((sum, call) => sum + (call[0] as number), 0)).toBe(6000);
  });
  it("does not retry non-transient failures or aborted requests", async () => {
    const run = vi.fn(async () => { throw new ApiError("nope", 404); });
    await expect(withTransientRetry(run, { sleep: async () => {} })).rejects.toThrow("nope");
    expect(run).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    const aborted = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(withTransientRetry(aborted, { signal: controller.signal })).rejects.toThrow("Failed to fetch");
    expect(aborted).toHaveBeenCalledTimes(1);
  });
});

describe("outage tracker", () => {
  it("only reports reconnecting after the threshold and clears on success", () => {
    vi.useFakeTimers();
    let t = 0;
    const tracker = createOutageTracker({ now: () => t, thresholdMs: 8000 });
    tracker.failure();
    expect(tracker.getSnapshot()).toBe(false);
    t = 7999; vi.advanceTimersByTime(7999); expect(tracker.getSnapshot()).toBe(false);
    t = 8000; vi.advanceTimersByTime(1); expect(tracker.getSnapshot()).toBe(true);
    expect(tracker.success()).toBe(true);
    expect(tracker.getSnapshot()).toBe(false);
    expect(tracker.success()).toBe(false);
    vi.useRealTimers();
  });
});

describe("non-JSON responses", () => {
  it("are transient so a restarting host shows Reconnecting instead of a raw-URL toast", async () => {
    const { NonJsonResponseError } = await import("./network-resilience");
    expect(isTransientNetworkError(new NonJsonResponseError("Engine local returned text/html for /api/x"))).toBe(true);
  });
});
