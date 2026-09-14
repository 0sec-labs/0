import { describe, expect, it } from "vitest";

import {
  clampMenuPosition,
  firstEnabledIndex,
  isRightClick,
  nextEnabledIndex,
  type ContextMenuItem,
} from "./use-context-menu.js";

const item = (label: string, disabled = false): ContextMenuItem => ({
  label,
  disabled,
  onSelect: () => {},
});

describe("isRightClick", () => {
  it("is true only for button 2", () => {
    expect(isRightClick({ button: 2 })).toBe(true);
    expect(isRightClick({ button: 0 })).toBe(false);
    expect(isRightClick({ button: 1 })).toBe(false);
  });

  it("is false for a missing event or button", () => {
    expect(isRightClick(undefined)).toBe(false);
    expect(isRightClick(null)).toBe(false);
    expect(isRightClick({})).toBe(false);
  });
});

describe("clampMenuPosition", () => {
  const menu = { width: 10, height: 5 };
  const viewport = { width: 80, height: 24 };

  it("opens down-and-right of the cursor when there is room", () => {
    expect(clampMenuPosition(5, 5, menu, viewport)).toEqual({ x: 5, y: 5 });
  });

  it("flips left when it would overflow the right edge", () => {
    // anchor 75 + width 10 = 85 > 80 → flip left: 75 - 10 = 65
    expect(clampMenuPosition(75, 5, menu, viewport)).toEqual({ x: 65, y: 5 });
  });

  it("flips up when it would overflow the bottom edge", () => {
    // anchor 22 + height 5 = 27 > 24 → flip up: 22 - 5 = 17
    expect(clampMenuPosition(5, 22, menu, viewport)).toEqual({ x: 5, y: 17 });
  });

  it("flips both when anchored in the bottom-right corner", () => {
    expect(clampMenuPosition(78, 23, menu, viewport)).toEqual({ x: 68, y: 18 });
  });

  it("never returns a negative position, even for a menu larger than the screen", () => {
    const huge = { width: 200, height: 100 };
    const pos = clampMenuPosition(10, 10, huge, viewport);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
  });

  it("clamps a flipped-left position back to zero rather than off-screen", () => {
    // anchor 5 + width 10 = 15 <= 12? no; with a narrow viewport it flips then clamps.
    const narrow = { width: 12, height: 24 };
    const pos = clampMenuPosition(9, 2, { width: 10, height: 3 }, narrow);
    // flip left → 9 - 10 = -1 → clamped to 0
    expect(pos.x).toBe(0);
  });
});

describe("firstEnabledIndex", () => {
  it("returns the first non-disabled row", () => {
    expect(firstEnabledIndex([item("a", true), item("b"), item("c")])).toBe(1);
  });

  it("returns -1 when every row is disabled", () => {
    expect(firstEnabledIndex([item("a", true), item("b", true)])).toBe(-1);
  });

  it("returns -1 for an empty list", () => {
    expect(firstEnabledIndex([])).toBe(-1);
  });
});

describe("nextEnabledIndex", () => {
  const items = [item("a"), item("b", true), item("c")];

  it("skips disabled rows moving down", () => {
    expect(nextEnabledIndex(items, 0, 1)).toBe(2);
  });

  it("skips disabled rows moving up", () => {
    expect(nextEnabledIndex(items, 2, -1)).toBe(0);
  });

  it("wraps around the ends", () => {
    expect(nextEnabledIndex(items, 2, 1)).toBe(0);
    expect(nextEnabledIndex(items, 0, -1)).toBe(2);
  });

  it("holds still when there is only one enabled row", () => {
    const one = [item("a"), item("b", true)];
    expect(nextEnabledIndex(one, 0, 1)).toBe(0);
    expect(nextEnabledIndex(one, 0, -1)).toBe(0);
  });

  it("returns -1 when nothing is enabled or the list is empty", () => {
    expect(nextEnabledIndex([item("a", true)], 0, 1)).toBe(-1);
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });
});
