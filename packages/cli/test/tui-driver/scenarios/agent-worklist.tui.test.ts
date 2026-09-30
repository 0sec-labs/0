import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { modelsByokLaunch } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("Main and subagents share the composer and full-width clickable task list", async () => {
  const options = modelsByokLaunch({ mouse: true });
  tui = await launch({ ...options, route: { type: "chat" }, cols: 100, rows: 34,
    env: { ...options.env, OSEC_TUI_DEMO_AGENTS: "1" }, settings: { ...options.settings, reduceMotion: true } });
  await tui.waitForText(/secret scanning/);
  expect(tui.rawFrame()).toMatch(/\b(?:\d+s|\d+m\d{2}s|\d+h\d{2}m)\b/);
  await tui.sendKeys("main draft");
  expect(tui.captureFrame()).toContain("recon web tier");
  expect(tui.captureFrame()).toContain("enumerating /api endpoints");
  expect(tui.captureFrame()).toContain("auth & session fuzzing");
  expect(tui.captureFrame()).toContain("cookie tampering");
  expect(tui.captureFrame()).toContain("secret scanning");
  expect(tui.captureFrame()).not.toContain("Spawn lineage");
  expect(tui.captureFrame()).not.toContain("TRANSCRIPT");

  const mainRows = tui.rawFrame().replace(/਀/g, " ").split("\n");
  const workerY = mainRows.findIndex((row) => row.includes("auth & session fuzzing"));
  expect(workerY).toBeGreaterThanOrEqual(0);
  await tui.click(mainRows[workerY]!.indexOf("auth & session fuzzing"), workerY);
  expect(tui.captureFrame()).toContain("to auth & session fuzzing");
  await tui.sendKeys("worker draft");
  expect(tui.captureFrame()).toContain("worker draft");
  await tui.sendKey("return");
  expect(tui.captureFrame()).toContain("to auth & session fuzzing");
  expect(tui.captureFrame()).toContain("worker draft");

  await tui.sendKey("down");
  expect(tui.captureFrame()).toContain("to secret scanning");
  // Ctrl+Shift+Home switches to Main without taking the composer/input out of service.
  await tui.sendKey("home", { ctrl: true, shift: true });
  expect(tui.captureFrame()).toContain("main draft");
  expect(tui.captureFrame()).not.toMatch(/› worker draft/);
});
