import { describe, expect, it } from "vitest";

import {
  POPUP_BACKDROP_COLOR,
  anchoredPosition,
  backdropDismissMode,
  modalPanelGeometry,
  resolveBackdropColor,
} from "./popup.js";

describe("modal panel geometry", () => {
  it("fits the viewport and child surface across terminal sizes and close modes", () => {
    for (const width of [1, 2, 3, 4, 5, 8, 9, 12, 20, 40, 80, 100, 200]) {
      for (const height of [1, 2, 3, 4, 6, 7, 8, 10, 11, 14, 24, 50, 80]) {
        for (const size of ["small", "medium", "large", "xlarge"] as const) {
          for (const dismissible of [false, true]) {
            const g = modalPanelGeometry({ width, height }, size, dismissible);
            expect(g.left).toBeGreaterThanOrEqual(0);
            expect(g.top).toBeGreaterThanOrEqual(0);
            expect(g.left + g.panelWidth).toBeLessThanOrEqual(width);
            expect(g.top + g.panelHeight).toBeLessThanOrEqual(height);
            expect(g.inner.width).toBeGreaterThanOrEqual(1);
            expect(g.inner.height).toBeGreaterThanOrEqual(1);
            expect(g.inner.width + g.paddingX * 2).toBe(g.panelWidth);
            expect(g.inner.height + g.paddingY * 2 + g.closeRows).toBe(g.panelHeight);
            expect(Math.abs(g.left - (width - g.left - g.panelWidth))).toBeLessThanOrEqual(1);
            expect(Math.abs(g.top - (height - g.top - g.panelHeight))).toBeLessThanOrEqual(1);
            expect(g.closeRows).toBe(dismissible && g.panelHeight - g.paddingY * 2 >= 2 ? 1 : 0);
          }
        }
      }
    }
  });

  it("bounds the panel instead of growing with a roomy terminal", () => {
    for (const size of ["small", "medium", "large", "xlarge"] as const) {
      const roomy = modalPanelGeometry({ width: 200, height: 80 }, size);
      const huge = modalPanelGeometry({ width: 400, height: 160 }, size);
      expect(huge.panelWidth).toBe(roomy.panelWidth);
      expect(huge.panelHeight).toBe(roomy.panelHeight);
      expect(roomy.panelWidth).toBeLessThan(200);
      expect(roomy.panelHeight).toBeLessThan(80);
    }
  });
  it("gives xlarge a substantially larger panel on a roomy terminal", () => {
    const large = modalPanelGeometry({ width: 140, height: 72 }, "large");
    const xlarge = modalPanelGeometry({ width: 140, height: 72 }, "xlarge");
    expect(xlarge.panelWidth).toBe(120);
    expect(xlarge.panelHeight).toBe(52);
    expect(xlarge.inner.width).toBeGreaterThan(large.inner.width);
    expect(xlarge.inner.height).toBeGreaterThan(large.inner.height);
  });

  it("keeps xlarge within a compact terminal", () => {
    const terminal = { width: 80, height: 24 };
    const geometry = modalPanelGeometry(terminal, "xlarge");
    expect(geometry.panelWidth).toBe(76);
    expect(geometry.panelHeight).toBe(20);
    expect(geometry.left).toBe(2);
    expect(geometry.top).toBe(2);
    expect(geometry.left + geometry.panelWidth).toBeLessThanOrEqual(terminal.width);
    expect(geometry.top + geometry.panelHeight).toBeLessThanOrEqual(terminal.height);
  });

  it("reserves only one close row and retains content even in a one-row viewport", () => {
    const terminal = { width: 100, height: 50 };
    const plain = modalPanelGeometry(terminal, "large");
    const dismissible = modalPanelGeometry(terminal, "large", true);
    expect(dismissible.inner.width).toBe(plain.inner.width);
    expect(dismissible.inner.height + dismissible.closeRows).toBe(plain.inner.height);
    expect(dismissible.closeRows).toBe(1);

    const tiny = modalPanelGeometry({ width: 3, height: 3 }, "large", true);
    expect(tiny.closeRows).toBe(1);
    expect(tiny.inner).toEqual({ width: 3, height: 2 });
    const singleRow = modalPanelGeometry({ width: 3, height: 1 }, "large", true);
    expect(singleRow.closeRows).toBe(0);
    expect(singleRow.inner.height).toBe(1);
  });
});

describe("anchored placement", () => {
  it("places the box at the cursor when it fits", () => {
    expect(anchoredPosition({ x: 5, y: 5 }, { width: 10, height: 4 }, { width: 80, height: 24 })).toEqual({ x: 5, y: 5 });
  });

  it("flips left and up when the box would overflow the viewport", () => {
    // 78 + 10 > 80 → x = 78 - 10; 22 + 4 > 24 → y = 22 - 4.
    expect(anchoredPosition({ x: 78, y: 22 }, { width: 10, height: 4 }, { width: 80, height: 24 })).toEqual({ x: 68, y: 18 });
  });

  it("pins to the origin when the box is larger than the viewport", () => {
    expect(anchoredPosition({ x: 5, y: 5 }, { width: 200, height: 200 }, { width: 80, height: 24 })).toEqual({ x: 0, y: 0 });
  });
});

describe("backdrop", () => {
  it("dims with the verbatim scrim colour, else nothing", () => {
    expect(resolveBackdropColor("dim")).toBe(POPUP_BACKDROP_COLOR);
    expect(resolveBackdropColor("transparent")).toBeUndefined();
    expect(resolveBackdropColor("none")).toBeUndefined();
  });

  it("picks the dismiss mode from the variant and the dismiss flag", () => {
    // Modal keeps its selection-aware guard; the others dismiss on any press.
    expect(backdropDismissMode("modal", true)).toBe("selection-aware");
    expect(backdropDismissMode("anchored", true)).toBe("simple");
    expect(backdropDismissMode("centered", true)).toBe("simple");
    // dismissOnBackdrop=false silences the backdrop entirely (ShutdownDialog / DialogSelect).
    expect(backdropDismissMode("modal", false)).toBe("none");
    expect(backdropDismissMode("anchored", false)).toBe("none");
    expect(backdropDismissMode("centered", false)).toBe("none");
  });
});
