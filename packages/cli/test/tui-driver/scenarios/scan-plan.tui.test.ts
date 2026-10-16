import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";

let tui: TuiHandle | undefined;
afterEach(async () => { await tui?.close(); tui = undefined; vi.restoreAllMocks(); });

test("guided setup explains recommendations and shared estimated limits before confirmation", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ route: { type: "launcher" }, cols: 150, rows: 50, settings: { onboardingCompleted: true } });
  await tui.sendKeys("https://example.test");
  await tui.sendKey("tab"); // goal
  await tui.waitForText(/unsafe/);
  expect(tui.captureFrame()).toContain("misconfigurations");
  await tui.sendKey("tab"); // provider
  await tui.sendKey("tab"); // depth
  await tui.waitForText(/focused/);
  await tui.sendKey("tab"); // runs
  await tui.waitForText(/subagents/);
  await tui.sendKey("right");
  await tui.sendKey("tab"); // execution
  await tui.waitForText(/sooner/);
  await tui.sendKey("right");
  await tui.sendKey("tab"); // time
  await tui.waitForText(/incomplete/);
  await tui.sendKey("tab"); // cost
  await tui.waitForText(/ceiling/);
  expect(tui.captureFrame()).toContain("2 runs");
  await tui.sendKey("return");
  await tui.waitForText(/In-flight cost/);
  expect(tui.captureFrame()).toContain("Enter confirms");
});
