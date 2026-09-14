/**
 * Keyboard scrolling wins over a stationary mouse — regression guard for the
 * hover-vs-scroll fix (commit 0e7ecdc1).
 *
 * The model list highlights the row the mouse hovers (`onHoverRow`) AND the row
 * the keyboard lands on (`onScroll`/arrow keys). The trap: when the keyboard
 * scrolls the list, a new row slides UNDER the stationary pointer and OpenTUI
 * re-fires `onMouseOver` on it with the SAME pointer coordinates. Honouring that
 * would snap the selection back to the mouse and fight keyboard navigation, so
 * dialog-select.tsx guards hover-select to fire only when the pointer actually
 * MOVED (`lastHoverPosRef`). This drives that exact sequence headlessly:
 *
 *   1. the mouse hovers a row — the highlight follows the pointer (proves mouse
 *      dispatch is live in the harness, via the driver's renderable bridge);
 *   2. WITHOUT moving the mouse, the keyboard presses "down" — the selection
 *      advances PAST the hovered row and does NOT snap back to it.
 *
 * If the guard regresses, the re-fired same-coordinate hover pulls the
 * selection back to the mouse's row and step 2 fails.
 *
 * This scenario needs the renderer's hit grid armed, so it launches with
 * `mouseSupport: true` (mouse is off in the default deterministic env). Mouse
 * dispatch to React handlers only works because the driver bridges OpenTUI's
 * module-duplicated `renderablesByNumber` maps — see `driver.ts`.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { highlightedRow, modelsByokLaunch } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("keyboard scroll advances past the hovered row, ignoring the stationary mouse", async () => {
  tui = await launch(modelsByokLaunch({ mouse: true }));
  await tui.waitForText(/per M/, 15_000);
  await tui.settle();

  const start = highlightedRow(tui.captureSpans());
  expect(start.index, "no highlighted row at start").toBeGreaterThanOrEqual(0);

  // Hover a lower list row. The highlight follows the mouse to it — this both
  // proves mouse dispatch is live and moves the selection off its start row.
  const hoverY = start.index + 3;
  await tui.moveMouse(20, hoverY);
  const hovered = highlightedRow(tui.captureSpans());

  expect(hovered.index, "mouse hover did not move the selection").toBe(hoverY);
  expect(hovered.index).toBeGreaterThan(start.index);

  // Press "down" WITHOUT moving the mouse. The list scrolls a new row under the
  // stationary pointer; the guard ignores that same-coordinate re-hover, so the
  // selection advances one past the hovered row rather than snapping back to it.
  await tui.sendKey("down");
  const afterKey = highlightedRow(tui.captureSpans());

  expect(afterKey.index, "keyboard scroll did not advance past the hovered row").toBe(
    hovered.index + 1,
  );
  expect(
    afterKey.text,
    "selection snapped back to the stationary mouse row (hover-vs-scroll regression)",
  ).not.toBe(hovered.text);
});
