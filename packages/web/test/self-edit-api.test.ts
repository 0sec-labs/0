import { describe, expect, it } from "vitest";
import { pollDelay, type SelfEditStatus } from "../src/lib/self-edit-api";

const status = (phase: SelfEditStatus["preview"]["phase"], gates?: "running"): SelfEditStatus => ({
  enabled: true, applyAvailable: false, protectedAreas: [],
  preview: { phase, logTail: [], ...(gates ? { gates: { status: gates, steps: [], protected: { ok: true, hits: [] } } } : {}) },
});

describe("self-edit polling", () => {
  it("polls fast while work is in flight and slower otherwise", () => {
    expect(pollDelay(status("starting"))).toBe(1500);
    expect(pollDelay(status("running", "running"))).toBe(1500);
    expect(pollDelay(status("running"))).toBe(5000);
    expect(pollDelay(status("idle"))).toBe(10_000);
    expect(pollDelay(undefined)).toBe(10_000);
  });
});
