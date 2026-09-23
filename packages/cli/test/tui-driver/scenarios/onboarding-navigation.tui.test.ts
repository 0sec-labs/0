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

async function firstRun(cols = 100, rows = 34, openSetup = true) {
  // Every request is synthetic, including connection checks during chat startup.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 503 }));
  // An Escape regression must fail, not terminate the test worker successfully.
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected application exit"); });
  const screen = await launch({ ...modelsByokLaunch(), route: { type: "chat" }, cols, rows,
    settings: { onboardingCompleted: false, mouseSupport: true } });
  await screen.waitForText(/type to chat or \/ for commands/);
  if (openSetup) {
    await screen.sendKeys("/onboard");
    await screen.sendKey("return");
    await screen.waitForText(/Step 1 of 6/);
  }
  return screen;
}

test("first launch opens chat; optional setup returns without completing or quitting", async () => {
  tui = await firstRun(100, 34, false);
  expect(tui.captureFrame()).not.toContain("Step 1 of 6");
  expect(tui.captureFrame()).not.toContain("provider initialized");
  await tui.sendKeys("/onboard");
  await tui.sendKey("return");
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

test("theme preview colors follow the draft without saving it", async () => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKey("n", { ctrl: true });
  await tui.sendKey("n", { ctrl: true });
  await tui.waitForText(/Step 4 of 6/);
  const originalTheme = getSettings().theme;
  const previewColors = () => {
    const lines = tui!.captureSpans().lines;
    const sample = lines.findIndex((line) => line.spans.map((span) => span.text).join("").includes("operator warn error"));
    expect(sample).toBeGreaterThan(0);
    // Exclude surrounding chrome and the gaps, whose colors legitimately
    // change only after the highlighted theme is confirmed.
    const start = lines[sample].spans.map((span) => span.text).join("").indexOf("0 operator");
    expect(start).toBeGreaterThanOrEqual(0);
    const backgrounds = lines[sample - 1].spans.flatMap((span) => Array.from({ length: span.width }, () => span.bg.toInts()));
    return {
      swatches: Array.from({ length: 10 }, (_, i) => backgrounds[start + i * 3]),
      sample: lines[sample].spans.filter((span) => span.text.trim()).map((span) => [span.text, span.fg.toInts()]),
    };
  };
  const original = previewColors();
  await tui.sendKey("right");
  const draft = previewColors();
  expect(draft.swatches).not.toEqual(original.swatches);
  expect(draft.sample).not.toEqual(original.sample);
  expect(getSettings().theme).toBe(originalTheme);
  await tui.sendKey("left");
  expect(previewColors()).toEqual(original);
  await tui.sendKey("right");
  await tui.sendKey("escape");
  await tui.sendKey("n", { ctrl: true });
  expect(previewColors()).toEqual(original);
  expect(getSettings().theme).toBe(originalTheme);
  await tui.sendKey("right");
  await tui.sendKey("return");
  expect(getSettings().theme).not.toBe(originalTheme);
  await tui.sendKey("escape");
  expect(previewColors()).toEqual(draft);
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

test("connected provider Continue advances to model selection", async () => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKeys("/deepseek");
  await tui.waitForText(/\[⏎\] continue/);
  await tui.sendKey("return");
  await tui.waitForText(/Models/);
  await tui.sendKey("escape");
  await tui.waitForText(/Connections/);
});

test("connected cloud Enter invokes Continue with hosted account", async () => {
  // Mock the account endpoint to return a verified usage-v2 account.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("inference/account")) {
      return Response.json({
        schemaVersion: "usage-v2",
        snapshotAt: "2026-09-22T12:00:00.000Z",
        scope: { orgId: "test-org" },
        state: "ready",
        reason: null,
        plan: { id: "pro", name: "Pro", monthlyPriceUsd: "15.00" },
        included: { state: "active", usedPercent: 10, resetsAt: "2026-10-01T00:00:00.000Z" },
        prepaid: { balanceUsd: "10.00", fallbackEnabled: false },
        canManageBilling: true,
        admission: { eligible: true, reason: null },
      });
    }
    return new Response(null, { status: 503 });
  });
  tui = await launch({
    ...modelsByokLaunch(),
    route: { type: "chat" },
    env: { ...modelsByokLaunch().env, ZERO_CLOUD_TOKEN: "sk-test-cloud" },
    settings: { onboardingCompleted: false },
  });
  await tui.waitForText(/type to chat or \/ for commands/);
  await tui.sendKeys("/onboard");
  await tui.sendKey("return");
  await tui.waitForText(/Step 1 of 6/);
  // Welcome → Connect
  await tui.sendKey("return");
  await tui.waitForText(/\[⏎\] continue/);
  await tui.sendKey("return");
  // With hosted skip, should advance past Models directly to Preferences.
  await tui.waitForText(/Step 4 of 6|Theme|Density/);
  await tui.sendKey("escape");
  await tui.waitForText(/Connections/);
  await tui.sendKeys("/deepseek");
  await tui.waitForText(/\[⏎\] continue/);
  await tui.sendKey("return");
  await tui.waitForText(/Models/);
});

test("rejected cloud token does not Continue; Enter re-initiates auth", async () => {
  // Mock account endpoint to return 401 → rejected verification.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("inference/account")) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    return new Response(null, { status: 503 });
  });
  tui = await launch({
    ...modelsByokLaunch(),
    route: { type: "chat" },
    env: { ...modelsByokLaunch().env, ZERO_CLOUD_TOKEN: "sk-expired-test-token" },
    settings: { onboardingCompleted: false },
  });
  await tui.waitForText(/type to chat or \/ for commands/);
  await tui.sendKeys("/onboard");
  await tui.sendKey("return");
  await tui.waitForText(/Step 1 of 6/);
  await tui.sendKey("return"); // Welcome → Connect
  await tui.settle();
  // Wait for verification to complete (rejected).
  await tui.waitForText(/rejected/i);
  // Cloud row is at index 0. Enter must still start hosted auth, not Continue.
  await tui.sendKey("return");
  await tui.waitForText(/Synthetic login pending|sign.in/i);
  await tui.sendKey("escape"); // cancel auth
  await tui.settle();
  expect(hosted.cancel).toHaveBeenCalled();
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
