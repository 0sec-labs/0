import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { modelsByokLaunch } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => { await tui?.close(); tui = undefined; vi.restoreAllMocks(); });

test("Alt+arrows navigate route history without leaking into model filtering", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ ...modelsByokLaunch(), settings: { onboardingCompleted: true } });
  await tui.waitForText(/per M/);
  await tui.sendKey("left", { meta: true });
  expect(tui.captureFrame()).not.toMatch(/per M/);
  await tui.sendKey("right", { meta: true });
  await tui.waitForText(/per M/);
  await tui.sendKeys("["); // printable brackets remain filter input
  expect(tui.captureFrame()).toContain("› [");
  await tui.sendKey("escape");
  await tui.waitForText(/per M/);
  expect(tui.captureFrame()).not.toContain("› [");
});

test("a command popup owns input before route-history shortcuts", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ route: { type: "settings" }, settings: { onboardingCompleted: true } });
  await tui.sendKey("p", { ctrl: true });
  await tui.waitForText(/Commands/);
  await tui.sendKey("left", { meta: true });
  expect(tui.captureFrame()).toMatch(/Commands/);
  await tui.sendKey("escape");
  expect(tui.captureFrame()).toMatch(/Settings/);
  await tui.sendKey("left", { meta: true });
  expect(tui.captureFrame()).not.toMatch(/Reset all settings/);
});

test("Shift+Tab returns launcher focus to the previous field", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ route: { type: "launcher" }, settings: { onboardingCompleted: true } });
  await tui.sendKey("tab"); // runtime
  await tui.sendKey("tab"); // depth
  await tui.sendKey("tab", { shift: true }); // runtime
  await tui.sendKey("tab", { shift: true }); // target
  await tui.sendKeys("fixture-target");
  expect(tui.captureFrame()).toContain("fixture-target");
  await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toContain("fixture-target");
});

test("a launcher-local palette blocks history until it closes", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ route: { type: "launcher" }, settings: { onboardingCompleted: true } });
  await tui.sendKeys("fixture-target");
  await tui.sendKey("p", { ctrl: true });
  await tui.waitForText(/Control plane/);
  await tui.sendKey("left", { meta: true });
  expect(tui.captureFrame()).toContain("Control plane");
  await tui.sendKey("escape");
  expect(tui.captureFrame()).toContain("fixture-target");
  await tui.sendKey("left", { meta: true });
  expect(tui.captureFrame()).not.toContain("fixture-target");
});
