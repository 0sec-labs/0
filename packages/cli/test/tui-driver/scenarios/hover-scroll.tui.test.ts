/**
 * Pointer movement is informational; explicit clicks select a model row.
 *
 * The model picker uses a cursor-following list window. Letting hover change
 * the cursor can recenter that window underneath the pointer and make the
 * initial selection jump before the operator clicks. This exercises the real
 * headless mouse hit grid: movement keeps the current row, while a click on a
 * different visible row makes that row the selection without committing it.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { frameLines, highlightedRow, modelLabel, modelsByokLaunch } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("moving over a model does not jump selection; clicking selects only that row", async () => {
  tui = await launch(modelsByokLaunch({ mouse: true }));
  await tui.waitForText(/per M/, 15_000);
  await tui.settle();

  const start = highlightedRow(tui.captureSpans());
  expect(start.index, "no highlighted row at start").toBeGreaterThanOrEqual(0);
  const startLabel = modelLabel(start.text).toLowerCase();
  const target = frameLines(tui.rawFrame())
    .map((line, y) => {
      const match = line.match(/deepseek-[a-z0-9.-]+/i);
      return match ? { id: match[0], x: line.indexOf(match[0]), y } : undefined;
    })
    .find((row) => row !== undefined && row.y !== start.index && row.id.toLowerCase() !== startLabel);
  expect(target, "the connected provider fixture needs a second visible model").toBeDefined();

  await tui.moveMouse(target!.x, target!.y);
  expect(highlightedRow(tui.captureSpans()).text).toBe(start.text);

  await tui.click(target!.x, target!.y);
  const clicked = highlightedRow(tui.captureSpans());
  expect(modelLabel(clicked.text).toLowerCase(), tui.captureFrame()).toBe(target!.id.toLowerCase());
  expect(tui.captureFrame()).toContain("Select model");
});
