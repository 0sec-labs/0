import { describe, expect, it } from "vitest";

import {
  POPUP_BACKDROP_COLOR,
  anchoredPosition,
  backdropDismissMode,
  modalPanelGeometry,
  popupBandWidth,
  resolveBackdropColor,
} from "./popup.js";

/**
 * Geometry and behaviour guards for the shared `Popup` primitive. Rendering has
 * no test renderer in this suite (see onboarding-screen.test.tsx), so these
 * pin the pure placement/sizing exports the component projects onto — the same
 * numbers the old DialogSurface / ContextMenu drew by hand.
 */

describe("popup size bands", () => {
  // Regression guard: these are the verbatim DialogSurface bands. A change to
  // any of them changes every modal popup's width.
  it("keeps the 64 / 92 / 120 bands", () => {
    expect(popupBandWidth("small")).toBe(64);
    expect(popupBandWidth("medium")).toBe(92);
    expect(popupBandWidth("large")).toBe(120);
  });

  it("applies each band when the terminal is roomy", () => {
    const term = { width: 200, height: 80 };
    expect(modalPanelGeometry(term, "small").panelWidth).toBe(64);
    expect(modalPanelGeometry(term, "medium").panelWidth).toBe(92);
    expect(modalPanelGeometry(term, "large").panelWidth).toBe(120);
  });
});

describe("modal panel geometry", () => {
  it("clamps the height to 44", () => {
    // Tall terminal: height is capped by the 44 band, not the terminal.
    expect(modalPanelGeometry({ width: 200, height: 80 }, "large").panelHeight).toBe(44);
    expect(modalPanelGeometry({ width: 200, height: 400 }, "large").panelHeight).toBe(44);
  });

  it("clamps the width to the terminal on a narrow screen", () => {
    // width 40 → 40 - 4 = 36 wins over the 120 band.
    expect(modalPanelGeometry({ width: 40, height: 80 }, "large").panelWidth).toBe(36);
  });

  it("reserves a cell of border each side and centres in the upper third", () => {
    const g = modalPanelGeometry({ width: 100, height: 50 }, "medium");
    expect(g.panelWidth).toBe(92);
    expect(g.panelHeight).toBe(44);
    expect(g.border).toBe(true);
    expect(g.inner).toEqual({ width: 90, height: 42 });
    expect(g.left).toBe(Math.floor((100 - 92) / 2)); // 4
    expect(g.top).toBe(Math.floor((50 - 44) / 3)); // 2
  });

  it("shrinks the chrome margins on a tiny terminal", () => {
    // width/height <= threshold: no 4-cell margin subtracted.
    const g = modalPanelGeometry({ width: 3, height: 3 }, "large");
    expect(g.panelWidth).toBe(3);
    expect(g.panelHeight).toBe(3);
    expect(g.border).toBe(false); // not > 4
    expect(g.inner).toEqual({ width: 3, height: 3 }); // no border reserved
    expect(g.left).toBe(0);
    expect(g.top).toBe(0);
  });

  it("keeps a border once the box clears 4 cells but the terminal is short", () => {
    const g = modalPanelGeometry({ width: 200, height: 8 }, "large");
    // height 8 <= 10 → no margin; clamped to 8.
    expect(g.panelHeight).toBe(8);
    expect(g.border).toBe(true);
    expect(g.inner.height).toBe(6);
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
