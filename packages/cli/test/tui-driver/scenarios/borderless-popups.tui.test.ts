/**
 * Popups are borderless.
 *
 * The redesign dropped the boxed frame around overlays. This locks it in for
 * two overlays that render offline with no LLM turn: the composer's slash
 * command menu and the full model picker. We assert their OWN region carries no
 * box-drawing glyph — scoped to the region because the chat composer below
 * still draws a horizontal `─` rule, which is not part of the popup.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { BORDER_GLYPHS, HOME_READY, regionBetween } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("slash command menu has no box borders", async () => {
  tui = await launch();
  await tui.waitForText(HOME_READY, 15_000);
  await tui.sendKeys("/");
  await tui.waitForText(/all commands|\/help/, 8_000);

  // The popup owns the rows from its header ("… all commands") down to its
  // key-hint footer ("… esc close"); the composer rule sits below that.
  const popup = regionBetween(tui.rawFrame(), /all commands/, /\[esc\] close/);
  const offenders = popup.filter((line) => BORDER_GLYPHS.test(line));
  expect(offenders, `border glyphs in slash popup:\n${offenders.join("\n")}`).toEqual([]);
});

test("model picker has no box borders", async () => {
  tui = await launch({ route: { type: "models" } });
  await tui.waitForText(/Find a model|per M/, 15_000);

  // The picker owns the rows from its title ("◈ Models …") down to its
  // navigation hint ("↑↓ model …").
  const picker = regionBetween(tui.rawFrame(), /Models · /, /\[↑↓\] model/);
  const offenders = picker.filter((line) => BORDER_GLYPHS.test(line));
  expect(offenders, `border glyphs in model picker:\n${offenders.join("\n")}`).toEqual([]);
});
