/**
 * The theme setting actually paints.
 *
 * A theme that only changes a stored value nobody reads is the bug this pins
 * against: switching themes must change the colors on screen. We mount the home
 * screen under two shipped themes with distinct palettes ("golden-gate" — warm
 * tan/gold — vs "blue-team" — electric blue/titanium), capture the per-cell
 * foreground colors, and assert the set of colors the frame paints differs
 * between them. Compared as rendered hex, so it holds even if the terminal
 * capability degrade snaps the palette onto a smaller color cube.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { HOME_READY } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

/** The set of distinct foreground colors the frame paints, as `r,g,b` strings. */
async function foregroundColors(theme: string): Promise<Set<string>> {
  const handle = await launch({ settings: { theme } });
  try {
    await handle.waitForText(HOME_READY, 15_000);
    const frame = handle.captureSpans();
    const colors = new Set<string>();
    for (const line of frame.lines) {
      for (const span of line.spans) {
        if (span.text.trim() === "") continue; // ignore blank cells
        const [r, g, b] = span.fg.toInts();
        colors.add(`${r},${g},${b}`);
      }
    }
    return colors;
  } finally {
    await handle.close();
  }
}

test("primary/accent colors differ between themes", async () => {
  const golden = await foregroundColors("golden-gate");
  const blue = await foregroundColors("blue-team");

  // Each theme paints colors the other does not — the palette is genuinely
  // applied, not just stored.
  const onlyGolden = [...golden].filter((c) => !blue.has(c));
  const onlyBlue = [...blue].filter((c) => !golden.has(c));

  expect(golden.size).toBeGreaterThan(0);
  expect(blue.size).toBeGreaterThan(0);
  expect(
    onlyGolden.length + onlyBlue.length,
    `themes painted identical color sets:\ngolden=${[...golden].sort().join(" ")}\nblue=${[...blue].sort().join(" ")}`,
  ).toBeGreaterThan(0);
});
