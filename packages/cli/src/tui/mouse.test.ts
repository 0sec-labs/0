import { describe, expect, it } from "vitest";

import { clampScrollOffset, wheelOffsetStep, type WheelScrollInfo } from "./mouse.js";

const scroll = (direction: WheelScrollInfo["direction"], delta = 1): WheelScrollInfo => ({
  direction,
  delta,
});

describe("wheelOffsetStep", () => {
  it("returns 0 when there is no scroll payload", () => {
    expect(wheelOffsetStep(undefined)).toBe(0);
  });

  it("scrolls back (positive) on wheel-up and toward the tail (negative) on wheel-down", () => {
    expect(wheelOffsetStep(scroll("up"))).toBeGreaterThan(0);
    expect(wheelOffsetStep(scroll("down"))).toBeLessThan(0);
    expect(wheelOffsetStep(scroll("up"))).toBe(-wheelOffsetStep(scroll("down")));
  });

  it("ignores horizontal notches for a vertical offset", () => {
    expect(wheelOffsetStep(scroll("left"))).toBe(0);
    expect(wheelOffsetStep(scroll("right"))).toBe(0);
  });

  it("scales one notch by rowsPerNotch", () => {
    expect(wheelOffsetStep(scroll("up"), 5)).toBe(5);
    expect(wheelOffsetStep(scroll("down"), 5)).toBe(-5);
    expect(wheelOffsetStep(scroll("up"), 1)).toBe(1);
  });

  it("honours an accelerated delta proportionally and treats a 0 delta as one notch", () => {
    expect(wheelOffsetStep(scroll("up", 3), 2)).toBe(6);
    expect(wheelOffsetStep(scroll("down", 4), 1)).toBe(-4);
    expect(wheelOffsetStep(scroll("up", 0), 3)).toBe(3);
    expect(wheelOffsetStep(scroll("up", 2.4), 1)).toBe(2);
  });
});

describe("clampScrollOffset", () => {
  it("keeps the tail at zero and never goes negative", () => {
    expect(clampScrollOffset(-5)).toBe(0);
    expect(clampScrollOffset(0)).toBe(0);
  });

  it("caps at the oldest reachable row", () => {
    expect(clampScrollOffset(120, 40)).toBe(40);
    expect(clampScrollOffset(10, 40)).toBe(10);
  });

  it("is unbounded above by default and coerces non-finite input to the tail", () => {
    expect(clampScrollOffset(9_999_999)).toBe(9_999_999);
    expect(clampScrollOffset(Number.NaN)).toBe(0);
    expect(clampScrollOffset(Number.POSITIVE_INFINITY, 40)).toBe(40);
  });
});
