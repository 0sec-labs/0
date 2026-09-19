import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { getSettings } from "../../../src/tui/settings-store.js";
import { modelsByokLaunch } from "./_helpers.js";

const hosted = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("../../../src/tui/hosted-device-auth.js", async (original) => ({
  ...await original<typeof import("../../../src/tui/hosted-device-auth.js")>(),
  startHostedDeviceAuth: (options: { onUpdate: (update: unknown) => void }) => {
    options.onUpdate({ phase: "polling", message: "Synthetic login pending" });
    return { cancel: hosted.cancel };
  },
}));

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
  vi.restoreAllMocks();
});

async function firstRun(cols = 100, rows = 34) {
  // Every request is synthetic, including connection checks during chat startup.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  // An Escape regression must fail, not terminate the test worker successfully.
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected application exit"); });
  return launch({ ...modelsByokLaunch(), route: { type: "chat" }, cols, rows,
    settings: { onboardingCompleted: false, mouseSupport: true } });
}

test("first-run Escape skips into a usable chat without completing or quitting", async () => {
  tui = await firstRun();
  await tui.waitForText(/Step 1 of 6/);
  await tui.sendKey("escape");
  await tui.settle();
  expect(tui.captureFrame()).not.toContain("Step 1 of 6");
  expect(tui.captureFrame()).not.toMatch(/Stopping audits/);
  expect(getSettings().onboardingCompleted).toBe(false);
  await tui.sendKeys("draft survives setup");
  expect(tui.captureFrame()).toContain("draft survives setup");
  expect(process.exit).not.toHaveBeenCalled();
});

test.each([[100, 34], [64, 24]])("Back traverses decisions, filters unwind first, confirmed preferences survive (%ix%i)", async (cols, rows) => {
  tui = await firstRun(cols, rows);
  await tui.waitForText(/Step 1 of 6/);
  await tui.sendKey("return");
  await tui.waitForText(/skip/);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 6/);
  await tui.sendKey("return");
  await tui.sendKey("n", { ctrl: true }); // Connect → Models
  await tui.sendKeys("nonexistent-model-fixture");
  await tui.sendKey("escape"); // clear filter, remain in Models
  expect(tui.captureFrame()).not.toContain("nonexistent-model-fixture");
  await tui.sendKey("escape"); // Models → Connect
  expect(tui.captureFrame()).toMatch(/connect/i);
  await tui.sendKey("n", { ctrl: true });
  await tui.sendKey("n", { ctrl: true }); // Models → Theme
  await tui.waitForText(/Step 4 of 6/);
  const originalTheme = getSettings().theme;
  await tui.sendKey("right");
  expect(getSettings().theme).toBe(originalTheme); // highlighted draft only
  await tui.sendKey("escape");
  await tui.sendKey("n", { ctrl: true }); // revisit Theme; draft discarded
  await tui.sendKey("return");
  expect(getSettings().theme).toBe(originalTheme);
  expect(tui.captureFrame()).toMatch(/Density/);
  await tui.sendKey("escape");
  expect(tui.captureFrame()).toMatch(/Theme/);
  await tui.sendKey("right");
  await tui.sendKey("return");
  const chosenTheme = getSettings().theme;
  expect(chosenTheme).not.toBe(originalTheme);
  await tui.sendKey("s"); // Density → Analytics
  await tui.waitForText(/Step 5 of 6/);
  await tui.sendKey("escape");
  expect(tui.captureFrame()).toMatch(/Density/);
  expect(getSettings().theme).toBe(chosenTheme);
  await tui.sendKey("s");
  await tui.sendKey("s"); // Analytics → Done, preserving saved sharing choice
  await tui.waitForText(/Step 6 of 6/);
  expect(getSettings().onboardingCompleted).toBe(false);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 5 of 6/);
  await tui.sendKey("s");
  await tui.sendKey("return");
  expect(getSettings().onboardingCompleted).toBe(true);
  expect(process.exit).not.toHaveBeenCalled();
});

test("mouse Back uses the same previous-step transition", async () => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKey("n", { ctrl: true });
  await tui.sendKey("n", { ctrl: true });
  await tui.sendKey("s"); // Density
  const rows = tui.rawFrame().split("\n");
  const y = rows.findIndex((row) => row.includes("[Back]"));
  expect(y).toBeGreaterThanOrEqual(0);
  await tui.click(rows[y].indexOf("[Back]") + 2, y);
  expect(tui.captureFrame()).toMatch(/Theme/);
  expect(getSettings().onboardingCompleted).toBe(false);
});

test("credential entry cancels before the provider filter or wizard step", async () => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKeys("anthropic");
  await tui.sendKey("return");
  await tui.waitForText(/save/);
  await tui.sendKeys("synthetic-unsaved-key");
  await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 6/);
  expect(tui.captureFrame()).toMatch(/anthropic/i);
  // Filter mode then retained filter unwind locally before returning to Welcome.
  await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 6/);
  await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 6/);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 6/);
});

test("Escape cancels Cloud login before leaving Connect", async () => {
  hosted.cancel.mockClear();
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKey("return"); // the Cloud row
  await tui.waitForText(/Synthetic login pending/);
  await tui.sendKey("escape");
  expect(hosted.cancel).toHaveBeenCalledOnce();
  expect(tui.captureFrame()).not.toContain("Synthetic login pending");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 6/);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 6/);
});

test("rerun dismissal returns to chat without changing completion", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ ...modelsByokLaunch(), route: { type: "onboard" }, settings: { onboardingCompleted: true } });
  await tui.waitForText(/Step 1 of 6/);
  await tui.sendKey("escape");
  await tui.sendKeys("rerun draft");
  expect(tui.captureFrame()).toContain("rerun draft");
  expect(getSettings().onboardingCompleted).toBe(true);
});
