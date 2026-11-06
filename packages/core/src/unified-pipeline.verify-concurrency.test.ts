/**
 * Bounded fan-out for the blind-verify wave (`mapWithConcurrency`).
 *
 * The wave was a bare `Promise.all` over every finding, so a high-recall /
 * low-precision model — exactly what a cheap-model pooling strategy buys — could
 * spawn one verify agent per candidate with no ceiling. These tests pin the two
 * properties that make bounding SAFE: every item is still processed, and the
 * results still come back in input order, so verdicts cannot be shuffled onto
 * the wrong findings. They also pin the deliberate difference from
 * `hunt-scan.ts`'s `pool()`: errors propagate rather than becoming `null`.
 */

import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("never exceeds the limit, and still processes every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);

    const out = await mapWithConcurrency(items, 8, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1); // actually concurrent, not serialised
    expect(out).toHaveLength(50);
    expect(out).toEqual(items.map((n) => n * 2));
  });

  it("preserves input order even when tasks finish out of order", async () => {
    // The correctness property that matters most here: verify verdicts are
    // zipped back onto findings positionally, so a reordered result array
    // would attach the wrong verdict to the wrong finding.
    const delays = [30, 1, 20, 2, 10];
    const out = await mapWithConcurrency(delays, 5, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("propagates a rejection instead of substituting null", async () => {
    // hunt-scan's pool() maps a throwing task to null. Here that would read
    // downstream as "no verdict" and could drop a real finding, so this helper
    // mirrors Promise.all and rejects.
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("verify infra exploded");
        return n;
      }),
    ).rejects.toThrow("verify infra exploded");
  });

  it("handles an empty list without spawning workers", async () => {
    let called = 0;
    const out = await mapWithConcurrency<number, number>([], 8, async (n) => {
      called++;
      return n;
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  it("serialises correctly at limit 1", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4], 1, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBe(1);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it("never spawns more workers than items", async () => {
    // limit 100 over 3 items must not create 100 idle workers.
    const out = await mapWithConcurrency([1, 2, 3], 100, async (n) => n);
    expect(out).toEqual([1, 2, 3]);
  });

  it("does not start tasks when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = 0;
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      started++;
      return n;
    }, controller.signal);
    expect(started).toBe(0);
    expect(out).toHaveLength(3);
    expect(0 in out).toBe(false);
  });

  it("stops claiming queued tasks when signal aborts mid-flight", async () => {
    const controller = new AbortController();
    let inFlight = 0;
    const started: number[] = [];
    let gateResolve: () => void;
    const gate = new Promise<void>((r) => { gateResolve = r; });

    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      inFlight++;
      if (started.length === 2) {
        controller.abort();
        gateResolve();
      }
      await gate;
      inFlight--;
      return item * 10;
    }, controller.signal);

    const out = await run;
    expect(started).toEqual([0, 1]);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(10);
    expect(2 in out).toBe(false);
    expect(3 in out).toBe(false);
    expect(4 in out).toBe(false);
  });
});
