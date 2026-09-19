/**
 * The model picker header stays small.
 *
 * The header simplification collapsed the picker's top matter to the title row,
 * a target row, and the search field — so at most a few lines separate the
 * title from the first model option. This pins that: count the lines between
 * the title row and the first priced model option, and assert the header block
 * is small (≤ 3 lines). A regression that re-grows the header (extra banners,
 * legends, a multi-line preamble) trips this.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { frameLines } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("header block between title and first model option is ≤ 3 lines", async () => {
  tui = await launch({ route: { type: "models" } });
  await tui.waitForText(/per M/, 15_000);

  const lines = frameLines(tui.rawFrame());
  const titleRow = lines.findIndex((l) => /◈ Models · /.test(l));
  // The first model OPTION row carries a price ("$0.19/0.51 per M"); the group
  // header ("DEEPSEEK") and the detail panel do not.
  const firstOption = lines.findIndex(
    (l, i) => i > titleRow && /\$[\d.]+\/[\d.]+ per M/.test(l),
  );

  expect(titleRow, "title row not found").toBeGreaterThanOrEqual(0);
  expect(firstOption, "first model option not found").toBeGreaterThan(titleRow);

  const headerLines = firstOption - titleRow - 1;
  expect(
    headerLines,
    `header block was ${headerLines} lines:\n${lines.slice(titleRow, firstOption + 1).join("\n")}`,
  ).toBeLessThanOrEqual(3);
});
