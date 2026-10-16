import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { getSettings } from "../../../src/tui/settings-store.js";
import { frameLines, HOME_READY, modelsByokLaunch } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("the compact close control survives resize and dismisses without editing settings; Escape still cancels", async () => {
  tui = await launch({ ...modelsByokLaunch({ mouse: true }), route: { type: "settings" },
    cols: 120, rows: 40, settings: { onboardingCompleted: true, mouseSupport: true } });
  await tui.waitForText(/Settings/);
  const savedTheme = getSettings().theme;
  await tui.sendKeys("/theme");
  await tui.waitForText(/Theme/);
  await tui.resize(64, 18);
  const resized = await tui.waitForText(/Theme/);
  expect(resized).toContain("[⌃U] clear");
  const lines = frameLines(tui.rawFrame());
  const closeY = lines.findIndex((line) => /\bClose\b/.test(line));
  expect(closeY).toBeGreaterThanOrEqual(0);
  // The horizontal padding is part of the one-row mouse target.
  await tui.click(lines[closeY]!.indexOf("Close") - 1, closeY);
  await tui.waitForText(HOME_READY);
  expect(getSettings().theme).toBe(savedTheme);

  await tui.sendKeys("/settings");
  await tui.sendKey("return");
  await tui.waitForText(/Settings/);
  await tui.sendKey("escape");
  await tui.waitForText(HOME_READY);
  expect(getSettings().theme).toBe(savedTheme);
});

test("short generic windows keep a compact close action rather than spending the content area on tall buttons", async () => {
  tui = await launch({ ...modelsByokLaunch({ mouse: true }), route: { type: "settings" },
    cols: 40, rows: 8, settings: { onboardingCompleted: true, mouseSupport: true } });
  await tui.waitForText(/Search settings/);
  const lines = frameLines(tui.rawFrame());
  const y = lines.findIndex((line) => /\bClose\b/.test(line));
  expect(y).toBeGreaterThanOrEqual(0);
  await tui.click(lines[y]!.indexOf("Close") - 1, y);
  expect(tui.captureFrame()).not.toMatch(/\bClose\b|Search settings/);
});
