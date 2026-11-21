import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntentPrefetcher, INTENT_DELAY_MS, type IntentTarget } from "./intent-prefetch";

const path = (pathname: string): IntentTarget => ({ kind: "path", pathname });

describe("createIntentPrefetcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires only after the target is held for the delay", () => {
    const run = vi.fn();
    const intent = createIntentPrefetcher(run);
    intent.enter(path("/findings"));
    vi.advanceTimersByTime(INTENT_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledWith(path("/findings"));
  });

  it("does not fetch rows a pointer sweeps across", () => {
    const run = vi.fn();
    const intent = createIntentPrefetcher(run);
    for (const p of ["/skills", "/computers"]) { intent.enter(path(p)); vi.advanceTimersByTime(20); }
    intent.enter(undefined);
    vi.advanceTimersByTime(200);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps one timer when the same target is entered again", () => {
    const run = vi.fn();
    const intent = createIntentPrefetcher(run);
    intent.enter({ kind: "finding", fingerprint: "a" });
    vi.advanceTimersByTime(30);
    intent.enter({ kind: "finding", fingerprint: "a" });
    vi.advanceTimersByTime(20);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
