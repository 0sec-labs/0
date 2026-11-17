import { describe, expect, it } from "vitest";
import { skeletonHoldMs } from "./pending-gate";

describe("skeletonHoldMs", () => {
  it("never draws a skeleton for a wait of 250 ms or less", () => {
    expect(skeletonHoldMs(0)).toBe(0);
    expect(skeletonHoldMs(250)).toBe(0);
  });
  it("keeps a skeleton that just appeared for its full 500 ms", () => {
    expect(skeletonHoldMs(251)).toBe(499);
    expect(skeletonHoldMs(300)).toBe(450);
  });
  it("releases a long wait at once", () => {
    expect(skeletonHoldMs(750)).toBe(0);
    expect(skeletonHoldMs(5000)).toBe(0);
  });
});
