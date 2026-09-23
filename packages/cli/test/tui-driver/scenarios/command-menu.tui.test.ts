/** The command menu exposes exactly one visible selection highlight. */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { HOME_READY } from "./_helpers.js";
import {
  degradePalette,
  detectColorDepth,
  getTheme,
  parseHex,
} from "../../../src/tui/themes.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("the selected command wears the PRIMARY highlight, like the model picker", async () => {
  tui = await launch({ settings: { theme: "0" } });
  await tui.waitForText(HOME_READY, 15_000);
  await tui.sendKeys("/");
  await tui.waitForText(/all commands|\/help/, 8_000);
  await tui.settle();

  const theme = degradePalette(getTheme("0"), detectColorDepth(process.env));
  const primary = parseHex(theme.PRIMARY)!;
  const primaryKey = `${primary.r},${primary.g},${primary.b}`;

  const frame = tui.captureSpans();

  // Every line's run of PRIMARY-background cells that also carries text. The
  // full-bleed masthead strip at the very top is also PRIMARY, but it spans the
  // WHOLE width, so it is excluded by width — leaving only the highlighted
  // command row, a partial-width PRIMARY run exactly like the model picker's
  // active row.
  const highlighted: { text: string; width: number }[] = [];
  for (const line of frame.lines) {
    let width = 0;
    let text = "";
    for (const span of line.spans) {
      const [br, bg, bb] = span.bg.toInts();
      if (`${br},${bg},${bb}` === primaryKey) {
        width += span.width;
        text += span.text;
      }
    }
    // A partial-width PRIMARY run with text is a highlighted list row; the
    // edge-to-edge masthead strip (>= cols-5) is not.
    if (width > 0 && width < frame.cols - 5 && text.trim().length > 0) {
      highlighted.push({ text: text.trim(), width });
    }
  }

  // Exactly one highlighted row, and it is a slash command — the first one
  // (`/help`), which opens selected by default.
  expect(
    highlighted.length,
    `expected exactly one PRIMARY-highlighted row, got ${highlighted.length}:\n${highlighted
      .map((h) => h.text)
      .join("\n")}`,
  ).toBe(1);
  expect(highlighted[0]!.text, "the highlighted row is not a slash command").toMatch(/^\/\S/);
});
