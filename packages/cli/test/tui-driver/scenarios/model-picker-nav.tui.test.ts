/**
 * The model picker scrolls its list under keyboard navigation.
 *
 * This is the overlay-keyboard proof: a routed overlay screen (route "models",
 * i.e. `ModelScreen` behind `ModelRoute`) runs its OWN `useKeyboard`, and until
 * the driver settled a real macrotask before each keystroke that subscription
 * never attached under the headless renderer, so the list ignored the arrows.
 * (The nested-popups scenario documents that historical limitation.) With the
 * driver's settle-tick in place, ↓/↑ now drive the picker headlessly.
 *
 * The list is pinned to a deterministic direct-provider catalogue
 * (`modelsByokLaunch`) so its rows are stable from the first paint.
 * The highlighted row is read from rendered spans (`highlightedRow`): pressing
 * "down" moves the highlight to a later row and "up" retreats to exactly where
 * it started. If the settle-tick regresses (or the overlay stops subscribing),
 * the highlight never moves and this fails.
 */

import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { highlightedRow, modelsByokLaunch } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("arrow keys scroll the model list; up retreats to the start", async () => {
  tui = await launch(modelsByokLaunch());
  await tui.waitForText(/DEEPSEEK/, 15_000);
  await tui.settle();

  const start = highlightedRow(tui.captureSpans());
  expect(start.index, "no highlighted row at start").toBeGreaterThanOrEqual(0);
  expect(start.text, "highlighted row carries no model").toMatch(/DeepSeek|deepseek/i);

  // Press "down" several times: a LATER row (further down the list) becomes the
  // active one. The model TEXT is the stable identity — the screen line index
  // can shift a row when a status/detail line reflows, so nav is asserted on the
  // highlighted model, with the line index only as a coarse "moved down" check.
  for (let i = 0; i < 3; i += 1) await tui.sendKey("down");
  const afterDown = highlightedRow(tui.captureSpans());

  expect(afterDown.text, "a different model row is not highlighted").not.toBe(start.text);
  expect(afterDown.index, "highlight did not move down the list").toBeGreaterThan(start.index);

  // Press "up" the same number of times: the highlight retreats to the model it
  // started on.
  for (let i = 0; i < 3; i += 1) await tui.sendKey("up");
  const afterUp = highlightedRow(tui.captureSpans());

  expect(afterUp.text, "up did not retreat to the starting model").toBe(start.text);
});

test("Cloud credentials do not add hosted inference to connected model choices", async () => {
  const options = modelsByokLaunch();
  tui = await launch({
    ...options,
    env: { ...options.env, ZERO_CLOUD_TOKEN: "managed-service-only-token" },
  });
  await tui.waitForText(/DEEPSEEK/, 15_000);
  const frame = tui.captureFrame();
  expect(frame).not.toContain("0security Auto");
  expect(frame).not.toMatch(/^\s*HOSTED\s*$/m);
});

test("the single /model match leads to agents without running it; Left edits the draft, Enter opens a navigable picker", async () => {
  tui = await launch({
    ...modelsByokLaunch(),
    route: { type: "chat" },
    env: { ...modelsByokLaunch().env, OSEC_TUI_DEMO_AGENTS: "1" },
    settings: { reduceMotion: true },
  });
  await tui.waitForText(/agents \(2\)/, 15_000);
  await tui.sendKeys("/model");
  await tui.waitForText(/\/model · 1/);
  expect(tui.captureFrame()).toContain("open picker");

  // One matching command has nowhere to move: Down instead selects the first
  // worker, not /model. Down again moves to a genuinely different roster row.
  await tui.sendKey("down");
  const first = tui.captureFrame().match(/^\s*▸[^\n]+/m)?.[0] ?? "";
  expect(first).toMatch(/Enumerating \/api endpoints/i);
  await tui.sendKey("down");
  const second = tui.captureFrame().match(/^\s*▸[^\n]+/m)?.[0] ?? "";
  expect(second).toMatch(/Running replay/i);
  expect(second).not.toBe(first);
  await tui.sendKey("return");
  await tui.waitForText(/\[←\] Main/);
  await tui.sendKey("left");
  expect(tui.captureFrame()).not.toContain("[←] Main");

  // The draft survives roster/focus navigation. Left moves the visible caret,
  // and an insertion/backspace at that boundary edits rather than appends.
  await tui.sendKey("left");
  expect(tui.captureFrame()).toMatch(/\/mode█l/);
  await tui.sendKeys("x");
  expect(tui.captureFrame()).toMatch(/\/modex█l/);
  await tui.sendKey("backspace");
  expect(tui.captureFrame()).toMatch(/\/mode█l/);
  await tui.sendKey("return");
  await tui.waitForText(/DEEPSEEK/, 15_000);
  const start = highlightedRow(tui.captureSpans());
  await tui.sendKey("down");
  expect(highlightedRow(tui.captureSpans()).text).not.toBe(start.text);
});
