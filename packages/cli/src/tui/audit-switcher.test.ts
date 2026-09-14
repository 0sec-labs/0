import { describe, expect, it } from "vitest";
import {
  AUDIT_SWITCHER_EMPTY_VARIANTS,
  AUDIT_SWITCHER_HINT_VARIANTS,
} from "./audit-switcher.js";
import { fitHint } from "./text.js";

/**
 * The reported bug: the left Audits sidebar (~28–40 cols) painted its FIXED key
 * legend as `Ctrl+Alt: ↑↓ select · N new · W…` — a mid-word ellipsis. The hint
 * is now adaptive, so across every realistic sidebar width it must resolve to a
 * WHOLE authored variant and never end in a stray "…".
 */
describe("audit-switcher sidebar hint", () => {
  const widths = [28, 30, 34, 40, 46, 60];

  it("never truncates the key legend with a mid-word ellipsis at sidebar widths", () => {
    for (const columns of widths) {
      const line = fitHint(columns, AUDIT_SWITCHER_HINT_VARIANTS);
      expect(line.endsWith("..."), `legend clipped at ${columns} cols: ${line}`).toBe(false);
      // Whatever fits is one of the authored variants verbatim.
      expect(AUDIT_SWITCHER_HINT_VARIANTS as readonly string[]).toContain(line);
    }
  });

  it("never truncates the empty-state prompt at sidebar widths", () => {
    for (const columns of widths) {
      const line = fitHint(columns, AUDIT_SWITCHER_EMPTY_VARIANTS);
      expect(line.endsWith("..."), `empty prompt clipped at ${columns} cols: ${line}`).toBe(false);
      expect(AUDIT_SWITCHER_EMPTY_VARIANTS as readonly string[]).toContain(line);
    }
  });

  it("widens the legend as the pane grows", () => {
    // Narrowest realistic sidebar keeps the compact variant; a wide one gets more.
    expect(fitHint(26, AUDIT_SWITCHER_HINT_VARIANTS)).toBe("[↑↓] · [N] new · [W] close");
    expect(fitHint(34, AUDIT_SWITCHER_HINT_VARIANTS)).toBe("[↑↓] select · [N] new · [W] close");
    expect(fitHint(60, AUDIT_SWITCHER_HINT_VARIANTS)).toBe(
      "[⌃⌥↑↓] select · [N] new · [W] close · [*] unread",
    );
  });
});
