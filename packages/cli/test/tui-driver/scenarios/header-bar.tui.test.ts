/**
 * The header renders as a single ORANGE (theme PRIMARY) strip.
 *
 * The chrome redesign turned the two-line header (a title row plus a BORDER
 * divider row) into one full-width `PRIMARY` background strip carrying the
 * identity/status in a contrast-picked dark foreground. This pins that: on the
 * default `0` theme the top of the frame must contain a wide run of cells
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
  // Pin the signature 0 theme so the expected orange is deterministic.
  tui = await launch({ settings: { theme: "0" } });
  await tui.waitForText(HOME_READY, 15_000);
  await tui.settle();

  const theme = degradePalette(getTheme("0"), detectColorDepth(process.env));
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

test("header bar bleeds to BOTH terminal edges (column 0 and the last column)", async () => {
  // The redesign made the bar full-bleed: it escapes the screen frame's
  // horizontal padding so the orange reaches the very first and very last
  // column, rather than stopping a cell or two short of each edge.
  tui = await launch({ settings: { theme: "0" } });
  await tui.waitForText(HOME_READY, 15_000);
  await tui.settle();

  const theme = degradePalette(getTheme("0"), detectColorDepth(process.env));
  const primary = parseHex(theme.PRIMARY)!;
  const primaryKey = `${primary.r},${primary.g},${primary.b}`;

  const frame = tui.captureSpans();

  // Reconstruct each row's per-column background from its ordered spans, then
  // find the row that is PRIMARY across the WHOLE width — the full-bleed bar.
  let bledLine = -1;
  frame.lines.forEach((line, i) => {
    const cols: string[] = [];
    for (const span of line.spans) {
      const [br, bg, bb] = span.bg.toInts();
      const key = `${br},${bg},${bb}`;
      for (let c = 0; c < span.width; c += 1) cols.push(key);
    }
    if (cols.length < frame.cols) return;
    // The first and last painted columns must both be the orange, and the whole
    // row must be orange (a true edge-to-edge strip, not an inset block).
    const allPrimary = cols.slice(0, frame.cols).every((k) => k === primaryKey);
    if (allPrimary) bledLine = i;
  });

  expect(
    bledLine,
    "no full-bleed PRIMARY strip: the orange bar does not reach both terminal edges",
  ).toBeGreaterThanOrEqual(0);

  // Spell the edge guarantee out explicitly on that row.
  const edge = frame.lines[bledLine]!;
  const firstBg = edge.spans[0]!.bg.toInts();
  const lastBg = edge.spans[edge.spans.length - 1]!.bg.toInts();
  expect(`${firstBg[0]},${firstBg[1]},${firstBg[2]}`, "column 0 is not PRIMARY").toBe(primaryKey);
  expect(`${lastBg[0]},${lastBg[1]},${lastBg[2]}`, "the last column is not PRIMARY").toBe(primaryKey);
});
