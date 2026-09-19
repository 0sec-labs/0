/**
 * A multi-line paste collapses into a chip.
 *
 * Pasting a block into the composer must NOT dump the raw body into the input
 * (which would bury the prompt and leak the pasted content into the frame);
 * instead it shows a compact `[Pasted text #N · L lines]` chip. This drives a
 * real bracketed paste through the composer and asserts both halves: the chip
 * appears with the right line count, and the pasted body text is absent.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { HOME_READY } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("a 12-line paste shows a chip and hides the body", async () => {
  tui = await launch();
  await tui.waitForText(HOME_READY, 15_000);
  // Ensure the composer is fully mounted (and focused for paste) before pasting.
  await tui.settle();

  const lines = Array.from({ length: 12 }, (_, i) => `PASTEBODYLINE${i + 1}`);
  await tui.sendPaste(lines.join("\n"));

  // The chip: "[Pasted text #1 · 12 lines]" (the counter may climb across runs).
  const frame = await tui.waitForText(/\[Pasted text #\d+ · 12 lines\]/, 8_000);
  expect(frame).toMatch(/\[Pasted text #\d+ · 12 lines\]/);
  // The raw pasted body must not be present anywhere in the frame.
  expect(tui.rawFrame()).not.toContain("PASTEBODYLINE5");
});
