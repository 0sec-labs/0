/**
 * The header renders as a single ORANGE (theme PRIMARY) strip.
 *
 * The chrome redesign turned the two-line header (a title row plus a BORDER
 * divider row) into one full-width `PRIMARY` background strip carrying the
 * identity/status in a contrast-picked dark foreground. This pins that: on the
 * default `0sec` theme the top of the frame must contain a wide run of cells
 * whose BACKGROUND equals the theme's `PRIMARY` colour (the orange bar), and
 * the glyphs painted on it must use the readable foreground the bar computes —
 * never a colour that vanishes on orange.
 *
 * The expected `PRIMARY` is read through the same degrade path the app uses
 * (`getTheme` → `degradePalette` at the detected colour depth), so the check
 * holds even when the terminal capability snaps the palette onto a smaller
 * cube — exactly like the sibling `theme` scenario.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { HOME_READY } from "./_helpers.js";
import {
  degradePalette,
  detectColorDepth,
  getTheme,
  parseHex,
  readableOnPrimary,
} from "../../../src/tui/themes.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("header paints a wide PRIMARY strip with a legible foreground", async () => {
  // Pin the signature 0sec theme so the expected orange is deterministic.
  tui = await launch({ settings: { theme: "0sec" } });
  await tui.waitForText(HOME_READY, 15_000);
  await tui.settle();

  const theme = degradePalette(getTheme("0sec"), detectColorDepth(process.env));
  const primary = parseHex(theme.PRIMARY)!;
  const fg = parseHex(readableOnPrimary(theme))!;
  const key = (rgb: { r: number; g: number; b: number }) => `${rgb.r},${rgb.g},${rgb.b}`;
  const primaryKey = key(primary);
  const fgKey = key(fg);

  const frame = tui.captureSpans();

  // Find the widest run of PRIMARY-background cells anywhere in the frame — the
  // header strip. It must be substantial (a real bar, not an incidental cell).
  let barLine = -1;
  let barWidth = 0;
  let fgWidthOnBar = 0;
  frame.lines.forEach((line, i) => {
    let width = 0;
    let fgOnPrimary = 0;
    for (const span of line.spans) {
      const [br, bg, bb] = span.bg.toInts();
      if (`${br},${bg},${bb}` === primaryKey) {
        width += span.width;
        const [fr, fgc, fb] = span.fg.toInts();
        if (span.text.trim() !== "" && `${fr},${fgc},${fb}` === fgKey) fgOnPrimary += span.width;
      }
    }
    if (width > barWidth) {
      barWidth = width;
      barLine = i;
      fgWidthOnBar = fgOnPrimary;
    }
  });

  expect(barLine, "no PRIMARY-background strip found").toBeGreaterThanOrEqual(0);
  // A genuine header bar spans most of the row, not a stray cell.
  expect(barWidth, `PRIMARY strip too narrow (${barWidth} cells)`).toBeGreaterThan(
    Math.floor(frame.cols / 3),
  );
  // Its glyphs use the contrast-picked readable foreground, so text reads on
  // the orange bar.
  expect(fgWidthOnBar, "no readable foreground glyphs painted on the PRIMARY strip").toBeGreaterThan(0);
});
