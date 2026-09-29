import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getScopeEnforcementState } from "@0/core";
import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { getSettings } from "../../../src/tui/settings-store.js";
import { loadSettings, SETTING_DEFS } from "../../../src/tui/settings.js";
import { modelsByokLaunch } from "./_helpers.js";


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
    await screen.waitForText(/Step 1 of 7/);
  }
  return screen;
}

async function clickTopAction(label: string) {
  const rows = tui!.rawFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  // The horizontal padding remains clickable on the compact one-row control.
  await tui!.click(rows[y].indexOf(label) - 1, y);
}

test("first launch opens chat; optional setup returns without completing or quitting", async () => {
  tui = await firstRun(100, 34, false);
  expect(tui.captureFrame()).not.toContain("Step 1 of 7");
  expect(tui.captureFrame()).not.toContain("provider initialized");
  await tui.sendKeys("/onboard");
  await tui.sendKey("return");
  await tui.waitForText(/Step 1 of 7/);
  await tui.sendKey("escape");
  await tui.settle();
  expect(tui.captureFrame()).not.toContain("Step 1 of 7");
  expect(tui.captureFrame()).not.toMatch(/Stopping audits/);
  expect(getSettings().onboardingCompleted).toBe(false);
  await tui.sendKeys("draft survives setup");
  expect(tui.captureFrame()).toContain("draft survives setup");
  expect(process.exit).not.toHaveBeenCalled();
});

test.each([[100, 34], [64, 24]])("Back traverses decisions, filters unwind first, confirmed preferences survive (%ix%i)", async (cols, rows) => {
  tui = await firstRun(cols, rows);
  const sharingBefore = getSettings().analyticsLevel;
  const reportingBefore = getSettings().diagnosticReporting;
  const scopeBefore = getScopeEnforcementState().enabled;
  const pluginRoot = join(process.env["HOME"]!, ".0", "plugins");
  const pluginsBefore = existsSync(pluginRoot) ? readdirSync(pluginRoot).sort() : [];
  await tui.waitForText(/Step 1 of 7/);
  await tui.sendKey("return");
  await tui.waitForText(/Step 2 of 7/);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 7/);
  await tui.sendKey("return");
  await tui.sendKey("n", { ctrl: true }); // Connect → Models
  await tui.sendKeys("nonexistent-model-fixture");
  await tui.sendKey("escape"); // clear filter, remain in Models
  expect(tui.captureFrame()).not.toContain("nonexistent-model-fixture");
  await tui.sendKey("escape"); // Models → Connect
  expect(tui.captureFrame()).toMatch(/connect/i);
  await tui.sendKey("n", { ctrl: true });
  await tui.sendKey("n", { ctrl: true }); // Models → Theme
  await tui.waitForText(/Step 4 of 7/);
  const originalTheme = getSettings().theme;
  await tui.sendKey("right");
  expect(loadSettings(process.env["HOME"], process.env["HOME"]).theme).toBe(originalTheme);
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
  await tui.waitForText(/Step 5 of 7/);
  await tui.sendKey("escape");
  expect(tui.captureFrame()).toMatch(/Density/);
  expect(getSettings().theme).toBe(chosenTheme);
  await tui.sendKey("s");
  await tui.sendKey("s"); // Analytics → Plugins, preserving saved sharing choice
  await tui.waitForText(/Step 6 of 7/);
  expect(getSettings().analyticsLevel).toBe(sharingBefore);
  expect(getSettings().diagnosticReporting).toBe(reportingBefore);
  expect(getSettings().onboardingCompleted).toBe(false);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 5 of 7/);
  await tui.sendKey("s");
  await tui.sendKey("s"); // optional Plugins → Done
  await tui.waitForText(/Step 7 of 7/);
  expect(getSettings().onboardingCompleted).toBe(false);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 6 of 7/);
  await tui.sendKey("return");
  await tui.sendKey("return");
  expect(getSettings().onboardingCompleted).toBe(true);
  await tui.waitForText(/██|0.SECURITY/);
  expect(existsSync(pluginRoot) ? readdirSync(pluginRoot).sort() : []).toEqual(pluginsBefore);
  expect(getScopeEnforcementState().enabled).toBe(scopeBefore);
  expect(process.exit).not.toHaveBeenCalled();
});

test.each([[100, 34], [64, 24]])("compact window actions keep drafts separate from saved choices (%ix%i)", async (cols, rows) => {
  tui = await firstRun(cols, rows);
  const sharingBefore = getSettings().analyticsLevel;
  const reportingBefore = getSettings().diagnosticReporting;
  await clickTopAction("Next");
  await tui.waitForText(/Step 2 of 7/);
  await clickTopAction("Back");
  await tui.waitForText(/Step 1 of 7/);
  await clickTopAction("Next");
  await clickTopAction("Skip"); // Provider choices remain untouched.
  await tui.waitForText(/deepseek-chat/);
  await clickTopAction("Next");
  await tui.waitForText(/Step 4 of 7/);
  const savedTheme = loadSettings(process.env["HOME"], process.env["HOME"]).theme;
  const choices = SETTING_DEFS.find((def) => def.key === "theme")!.choices!;
  const draft = choices.find((choice) => choice !== savedTheme)!;
  const chooseDraft = async () => {
    const label = draft.replace(/-/g, " ");
    for (let attempt = 0; attempt <= choices.length; attempt++) {
      const frame = tui!.rawFrame().split("\n");
      const themeHeader = frame.findIndex((row) => /\bTheme\b/.test(row));
      const listColumn = frame[themeHeader].indexOf("Theme");
      const preview = frame.findIndex((row, index) => index > themeHeader && row.includes("PREVIEW"));
      expect(preview).toBeGreaterThan(themeHeader);
      const previewColumn = frame[preview].indexOf("PREVIEW");
      const y = frame.findIndex((row, index) => index > themeHeader
        && row.slice(listColumn, previewColumn).replace("●", "").trim() === label);
      if (y >= 0) {
        await tui!.click(frame[y].indexOf(label, listColumn), y);
        return;
      }
      // Short windows may initially hide the first theme; scroll the actual
      // picker, never mistake the mini-console's "0" for a selectable row.
      await tui!.scroll(listColumn + 1, themeHeader + 2, -1);
    }
    throw new Error(`Theme row ${label} did not become visible\n${tui!.rawFrame()}`);
  };
  await chooseDraft();
  expect(loadSettings(process.env["HOME"], process.env["HOME"]).theme).toBe(savedTheme);
  await clickTopAction("Back");
  await tui.waitForText(/Step 3 of 7/);
  await tui.waitForText(/deepseek-chat/);
  await clickTopAction("Next"); // Explicitly select the highlighted real model.
  await clickTopAction("Next"); // abandoned theme draft was discarded
  expect(getSettings().theme).toBe(savedTheme);
  await clickTopAction("Back");
  await chooseDraft();
  await clickTopAction("Next");
  expect(getSettings().theme).toBe(draft);
  expect(loadSettings(process.env["HOME"], process.env["HOME"]).theme).toBe(draft);
  await clickTopAction("Back");
  expect(getSettings().theme).toBe(draft);
  await clickTopAction("Next");
  await clickTopAction("Skip");
  await clickTopAction("Skip");
  expect(getSettings().analyticsLevel).toBe(sharingBefore);
  expect(getSettings().diagnosticReporting).toBe(reportingBefore);
  await clickTopAction("Next");
  await tui.waitForText(/Step 7 of 7/);
  expect(getSettings().onboardingCompleted).toBe(false);
  await clickTopAction("Finish");
  await tui.waitForText(/██|0.SECURITY/);
  expect(getSettings().onboardingCompleted).toBe(true);
});

test("focused keyboard actions perform the same forward, back and skip transitions", async () => {
  tui = await firstRun();
  await tui.sendKey("tab");
  await tui.sendKey("right"); // Move from focused Skip setup to Next.
  await tui.sendKey("return"); // Welcome's focused Next
  await tui.waitForText(/Step 2 of 7/);
  await tui.sendKey("tab", { ctrl: true }); // parent Back, not provider filter
  await tui.sendKey("return");
  await tui.waitForText(/Step 1 of 7/);
  await tui.sendKey("return");
  await tui.sendKey("tab", { ctrl: true });
  await tui.sendKey("tab"); // Skip
  await tui.sendKey("return");
  await tui.waitForText(/Step 3 of 7/);
  await tui.waitForText(/deepseek-chat/);
  await tui.sendKey("tab", { ctrl: true });
  await tui.sendKey("tab");
  await tui.sendKey("tab"); // Next
  await tui.sendKey("return");
  await tui.waitForText(/Step 4 of 7/);
  const saved = getSettings().theme;
  await tui.sendKey("right");
  expect(loadSettings(process.env["HOME"], process.env["HOME"]).theme).toBe(saved);
  await tui.sendKey("tab", { shift: true }); // Next from body
  await tui.sendKey("return");
  expect(getSettings().theme).not.toBe(saved);
  await tui.sendKey("tab"); // Back
  await tui.sendKey("return");
  const confirmed = getSettings().theme;
  await tui.sendKey("right");
  await tui.sendKey("tab"); // Back
  await tui.sendKey("tab"); // Skip
  await tui.sendKey("return");
  expect(getSettings().theme).toBe(confirmed);
  expect(getSettings().onboardingCompleted).toBe(false);
});

test("theme highlight repaints the console and window without saving, then Back rolls both back", async () => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKey("n", { ctrl: true });
  await tui.sendKey("n", { ctrl: true });
  await tui.waitForText(/Step 4 of 7/);
  const originalTheme = getSettings().theme;
  const previewColors = () => {
    const lines = tui!.captureSpans().lines;
    const sample = lines.find((line) => line.spans.map((span) => span.text).join("").includes("Findings verified."));
    const controls = lines.find((line) => line.spans.map((span) => span.text).join("").includes("Next"));
    expect(sample).toBeDefined();
    expect(controls).toBeDefined();
    return {
      console: sample!.spans.filter((span) => span.text.includes("Findings verified."))
        .map((span) => [span.fg.toInts(), span.bg.toInts()]),
      chrome: controls!.spans.filter((span) => span.text.includes("Next"))
        .map((span) => [span.fg.toInts(), span.bg.toInts()]),
    };
  };
  const original = previewColors();
  await tui.sendKey("right");
  const draft = previewColors();
  expect(draft.console).not.toEqual(original.console);
  expect(draft.chrome).not.toEqual(original.chrome);
  expect(getSettings().theme).not.toBe(originalTheme);
  expect(loadSettings(process.env["HOME"], process.env["HOME"]).theme).toBe(originalTheme);
  await tui.sendKey("left");
  expect(previewColors()).toEqual(original);
  await tui.sendKey("right");
  await clickTopAction("Back");
  await clickTopAction("Skip"); // Model choice unchanged while returning to Display.
  expect(previewColors()).toEqual(original);
  expect(getSettings().theme).toBe(originalTheme);
  await tui.sendKey("right");
  await clickTopAction("Next");
  expect(getSettings().theme).not.toBe(originalTheme);
  await clickTopAction("Back");
  expect(previewColors()).toEqual(draft);
});

test.each(["keyboard", "mouse"] as const)("%s cancellation unwinds credential entry before provider filters or wizard steps", async (input) => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKeys("anthropic");
  await tui.sendKey("return");
  await tui.waitForText(/Save/);
  await tui.sendKeys("synthetic-unsaved-key");
  expect(tui.captureFrame()).not.toContain("synthetic-unsaved-key");
  if (input === "mouse") await clickTopAction("Cancel");
  else await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 7/);
  expect(tui.captureFrame()).toMatch(/anthropic/i);
  // Filter mode then retained filter unwind locally before returning to Welcome.
  if (input === "mouse") await clickTopAction("Back");
  else await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 7/);
  if (input === "mouse") await clickTopAction("Back");
  else await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 7/);
  if (input === "mouse") await clickTopAction("Back");
  else await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 7/);
});


test("top Continue authenticates the selected saved provider and advances to model selection", async () => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKeys("/deepseek");
  await tui.waitForText(/Continue/);
  await clickTopAction("Continue");
  await tui.waitForText(/●\s+deepseek-chat/);
  await tui.sendKey("escape");
  await tui.waitForText(/Connections/);
});


test("rerun dismissal returns to chat without changing completion", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ ...modelsByokLaunch(), route: { type: "onboard" }, settings: { onboardingCompleted: true } });
  await tui.waitForText(/Step 1 of 7/);
  await tui.sendKey("escape");
  await tui.sendKeys("rerun draft");
  expect(tui.captureFrame()).toContain("rerun draft");
  expect(getSettings().onboardingCompleted).toBe(true);
});
