import { readFileSync, writeFileSync } from "node:fs";
import { analyticsPipeline, eventBus, getScopeEnforcementState } from "@0/core";
import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { getSettings, reloadSettings } from "../../../src/tui/settings-store.js";
import { loadSettings, settingsFilePath, SETTING_DEFS } from "../../../src/tui/settings.js";
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
  if (openSetup) {
    await screen.sendKeys("/onboard");
    await screen.sendKey("return");
    await screen.waitForText(/Step 1 of 5/);
  } else {
    await screen.waitForText(/type to chat or \/ for commands|draft here · restore access to send|Provider unavailable/i);
  }
  return screen;
}

async function clickTopAction(label: string) {
  const rows = tui!.rawFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y].indexOf(label) - 1;
  // Move first so the headless hit-grid is current after centered-layout reflow.
  await tui!.moveMouse(x, y);
  await tui!.click(x, y);
}


test("provider step summarizes detected names without revealing credential values", async () => {
  const variables = ["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "ZERO_CHATGPT_ACCESS_TOKEN"] as const;
  const previous: Record<(typeof variables)[number], string | undefined> = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
    ZERO_CHATGPT_ACCESS_TOKEN: process.env.ZERO_CHATGPT_ACCESS_TOKEN,
  };
  const secrets = ["onboarding-openai-secret", "onboarding-azure-secret", "onboarding-codex-secret"];
  try {
    tui = await firstRun();
    variables.forEach((name, index) => { process.env[name] = secrets[index]; });
    await tui.sendKey("return");
    await tui.waitForText(/Step 2 of 5/);
    const rows = tui.captureFrame().split("\n");
    const detectedIndex = rows.findIndex((line) => line.includes("Found keys for"));
    const detectedText = rows.slice(detectedIndex, detectedIndex + 5).join(" ");
    expect(detectedIndex).toBeGreaterThanOrEqual(0);
    expect(detectedText).toContain("OpenAI");
    expect(detectedText).toContain("Azure OpenAI");
    expect(detectedText).toContain("ChatGPT Codex");
    const frame = tui.captureFrame();
    expect(detectedText).toMatch(/press\s+Next\./);
    expect(frame).not.toMatch(/Not set up\.|Get a key at|Enter to paste a key/);
    for (const secret of secrets) expect(frame).not.toContain(secret);
  } finally {
    await tui?.close();
    tui = undefined;
    variables.forEach((name) => {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test("first launch opens chat; optional setup returns without completing or quitting", async () => {
  tui = await firstRun(100, 34, false);
  expect(tui.captureFrame()).not.toContain("Step 1 of 5");
  expect(tui.captureFrame()).not.toContain("provider initialized");
  await tui.sendKeys("/onboard");
  await tui.sendKey("return");
  await tui.waitForText(/Step 1 of 5/);
  const frame = tui.captureFrame();
  expect(frame).toContain("Hey there! Meet Zero.");
  expect(frame).toContain("Skip setup");
  expect(frame).toContain("Continue");
  expect(frame).not.toContain("0.SECURITY · OPERATOR CONSOLE");
  expect(frame).not.toContain("type to chat or / for commands");
  expect(frame).not.toMatch(/Ctrl\+P commands|Ctrl\+R check again/);
  const spans = tui.captureSpans().lines;
  const band = spans.find((line) => {
    const text = line.spans.map((span) => span.text).join("");
    return text.includes("Setup") && text.includes("Step 1 of 5 · Welcome");
  });
  const titleSpan = band?.spans.find((span) => span.text.includes("Setup"));
  const greetingSpan = spans.find((line) => line.spans.some((span) => span.text.includes("Hey there! Meet Zero.")))
    ?.spans.find((span) => span.text.includes("Hey there! Meet Zero."));
  expect(titleSpan).toBeDefined();
  expect(greetingSpan).toBeDefined();
  expect(titleSpan!.bg.toInts()).not.toEqual(greetingSpan!.bg.toInts());
  const continueRow = tui.rawFrame().split("\n").find((row) => row.includes("Continue"));
  expect(continueRow).toBeDefined();
  expect(Math.abs(continueRow!.indexOf("Continue") + 4 - 50)).toBeLessThan(5);
  await tui.sendKey("escape");
  await tui.settle();
  expect(tui.captureFrame()).not.toContain("Step 1 of 5");
  expect(tui.captureFrame()).not.toMatch(/Stopping audits/);
  expect(getSettings().onboardingCompleted).toBe(false);
  await tui.sendKeys("draft survives setup");
  expect(tui.captureFrame()).toContain("draft survives setup");
  expect(process.exit).not.toHaveBeenCalled();
});

test("fresh setup highlights usage without sending until Finish records consent", async () => {
  tui = await firstRun();
  const sent: Record<string, unknown>[] = [];
  try {
    // Only this consent scenario lifts the harness restrictions. All transports
    // remain captured and use synthetic credentials inside the throwaway home.
    for (const name of ["ZERO_OFFLINE", "ZERO_NO_TELEMETRY", "DO_NOT_TRACK"]) vi.stubEnv(name, undefined);
    vi.stubEnv("ZERO_ANALYTICS_LEVEL", undefined);
    vi.stubEnv("ZERO_CLOUD_HOST", "https://analytics.test");
    vi.stubEnv("ZERO_CLOUD_TOKEN", "test-token");
    analyticsPipeline.__resetForTests();
    analyticsPipeline.configure({
      homeDir: process.env["HOME"],
      fetchImpl: (async (_url, init) => {
        const batch = JSON.parse(String(init?.body)).records;
        sent.push(...batch);
        return new Response(JSON.stringify({ ok: true, accepted: batch.length }), { status: 202 });
      }) as typeof fetch,
    });
    reloadSettings();
    const reportingBefore = getSettings().diagnosticReporting;
    await tui.sendKey("return");
    await tui.sendKey("n", { ctrl: true });
    await tui.sendKey("n", { ctrl: true });
    // Model/connection preferences use full settings writes. This scenario
    // starts the final decision with no saved consent, not a persisted refusal.
    const path = settingsFilePath(process.env["HOME"]);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    delete saved.analyticsLevel;
    writeFileSync(path, JSON.stringify(saved));
    reloadSettings();
    await tui.sendKey("s"); // Preserve Theme; no incidental settings write.
    await tui.waitForText(/Step 5 of 5/);
    expect(tui.captureFrame()).toContain("● Share usage stats");
    await tui.sendKey("up");
    await tui.sendKey("down");
    eventBus.emit("tool_call_started", { tool: "before-finish", args_preview: "before consent", turn: 0, ts: 1 });
    await analyticsPipeline.flushNow();
    expect(sent).toEqual([]);
    expect(loadSettings(process.env["HOME"], process.env["HOME"]).analyticsLevel).toBe("off");
    await tui.sendKey("return");
    expect(getSettings().onboardingCompleted).toBe(true);
    expect(getSettings().diagnosticReporting).toBe(reportingBefore);
    expect(loadSettings(process.env["HOME"], process.env["HOME"]).analyticsLevel).toBe("usage");
    eventBus.emit("tool_call_started", { tool: "after-finish", args_preview: "after consent", turn: 0, ts: 2 });
    await analyticsPipeline.flushNow();
    expect(sent).toEqual([expect.objectContaining({ kind: "usage", featureCounts: { "after-finish": 1 } })]);
  } finally {
    analyticsPipeline.__resetForTests();
    vi.unstubAllEnvs();
  }
});

test.each([[100, 34], [64, 24]])("Back traverses decisions, filters unwind first, confirmed preferences survive (%ix%i)", async (cols, rows) => {
  tui = await firstRun(cols, rows);
  const sharingBefore = getSettings().analyticsLevel;
  const reportingBefore = getSettings().diagnosticReporting;
  const scopeBefore = getScopeEnforcementState().enabled;
  await tui.waitForText(/Step 1 of 5/);
  expect(tui.captureFrame()).toContain("Hey there! Meet Zero.");
  await tui.sendKey("return");
  await tui.waitForText(/Step 2 of 5/);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 5/);
  await tui.sendKey("return");
  await tui.sendKey("n", { ctrl: true }); // Connect → Models
  await tui.sendKeys("nonexistent-model-fixture");
  await tui.sendKey("escape"); // clear filter, remain in Models
  expect(tui.captureFrame()).not.toContain("nonexistent-model-fixture");
  await tui.sendKey("escape"); // Models → Connect
  expect(tui.captureFrame()).toMatch(/connect/i);
  await tui.sendKey("n", { ctrl: true });
  await tui.sendKey("n", { ctrl: true }); // Models → Theme
  await tui.waitForText(/Step 4 of 5/);
  const originalTheme = getSettings().theme;
  await tui.sendKey("right");
  expect(loadSettings(process.env["HOME"], process.env["HOME"]).theme).toBe(originalTheme);
  await tui.sendKey("escape");
  await tui.sendKey("n", { ctrl: true }); // revisit Theme; draft discarded
  await tui.sendKey("return");
  expect(getSettings().theme).toBe(originalTheme);
  await tui.waitForText(/Step 5 of 5/);
  expect(tui.captureFrame()).toContain("Change anytime in Settings");
  expect(tui.captureFrame()).toContain("● Off");
  expect(tui.captureFrame()).toContain("○ Share usage stats");
  expect(tui.captureFrame()).not.toMatch(/Tools and code|\bFull\b|identifying content|anonymous|environment opt-outs|problem reports|Hackstore|Density|Done/);
  await tui.sendKey("escape");
  expect(tui.captureFrame()).toMatch(/Theme/);
  await tui.sendKey("right");
  await tui.sendKey("return");
  const chosenTheme = getSettings().theme;
  expect(chosenTheme).not.toBe(originalTheme);
  await tui.sendKey("escape");
  expect(tui.captureFrame()).toMatch(/Theme/);
  expect(getSettings().theme).toBe(chosenTheme);
  await tui.sendKey("s");
  await tui.waitForText(/Step 5 of 5/);
  await tui.sendKey("down");
  expect(tui.captureFrame()).toContain("● Share usage stats");
  await tui.sendKey("up");
  expect(tui.captureFrame()).toContain("● Off");
  expect(getSettings().analyticsLevel).toBe(sharingBefore);
  expect(getSettings().diagnosticReporting).toBe(reportingBefore);
  await tui.sendKey("s"); // Final sharing skip completes without changing the saved tier.
  expect(getSettings().onboardingCompleted).toBe(true);
  await tui.waitForText(/type to chat or \/ for commands|draft here · restore access to send|Provider unavailable/);
  expect(tui.captureFrame()).not.toMatch(/Step \d of \d/);
  expect(getScopeEnforcementState().enabled).toBe(scopeBefore);
  expect(process.exit).not.toHaveBeenCalled();
});

test.each([[100, 34], [64, 24]])("compact window actions keep drafts separate from saved choices (%ix%i)", async (cols, rows) => {
  tui = await firstRun(cols, rows);
  const sharingBefore = getSettings().analyticsLevel;
  const reportingBefore = getSettings().diagnosticReporting;
  await tui.sendKey("return");
  await tui.waitForText(/Step 2 of 5/);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 5/);
  await tui.sendKey("return");
  await tui.sendKey("n", { ctrl: true }); // Provider → Models, preserving existing credentials.
  await tui.waitForText(/deepseek-chat/);
  await tui.sendKey("return");
  await tui.waitForText(/Step 4 of 5/);
  const savedTheme = loadSettings(process.env["HOME"], process.env["HOME"]).theme;
  const choices = SETTING_DEFS.find((def) => def.key === "theme")!.choices!;
  const draft = choices.find((choice) => choice !== savedTheme && choice !== "0")!;
  const chooseDraft = async () => {
    const label = draft.replace(/-/g, " ");
    for (let attempt = 0; attempt <= choices.length; attempt++) {
      const frame = tui!.rawFrame().split("\n");
      const themeHeader = frame.findIndex((row) => /\bTheme ·/.test(row));
      const listColumn = frame[themeHeader].indexOf("Theme");
      const preview = frame.findIndex((row, index) => index > themeHeader && row.includes("PREVIEW"));
      expect(preview).toBeGreaterThan(themeHeader);
      const previewColumn = frame[preview].indexOf("PREVIEW");
      const y = frame.findIndex((row, index) => index > themeHeader
        && row.slice(listColumn, previewColumn).replace("●", "").trim() === label);
      if (y >= 0) {
        const x = frame[y].indexOf(label, listColumn);
        await tui!.moveMouse(x, y);
        expect(getSettings().theme).toBe(savedTheme);
        await tui!.click(x, y);
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
  await tui.sendKey("escape");
  await tui.waitForText(/Step 3 of 5/);
  await tui.waitForText(/deepseek-chat/);
  await tui.sendKey("return"); // Explicitly select the highlighted real model.
  await tui.sendKey("return"); // Commit Theme after discarding the abandoned draft.
  expect(getSettings().theme).toBe(savedTheme);
  await tui.sendKey("escape");
  await tui.waitForText(/Step 4 of 5/);
  await chooseDraft();
  await tui.sendKey("return");
  expect(getSettings().theme).toBe(draft);
  expect(loadSettings(process.env["HOME"], process.env["HOME"]).theme).toBe(draft);
  await tui.sendKey("escape");
  expect(getSettings().theme).toBe(draft);
  await tui.sendKey("return");
  await tui.sendKey("s"); // Skip Theme to Data sharing.
  expect(getSettings().analyticsLevel).toBe(sharingBefore);
  expect(getSettings().diagnosticReporting).toBe(reportingBefore);
  await tui.waitForText(/type to chat or \/ for commands|draft here · restore access to send|Provider unavailable/);
  expect(getSettings().onboardingCompleted).toBe(true);
  expect(tui.captureFrame()).not.toMatch(/Step \d of \d/);
});

test("focused keyboard actions perform the same forward, back and skip transitions", async () => {
  tui = await firstRun();
  await tui.sendKey("tab");
  await tui.sendKey("right"); // Focus the centered Continue action from Skip setup.
  await tui.sendKey("return"); // Welcome's focused Continue
  await tui.waitForText(/Step 2 of 5/);
  await tui.sendKey("tab", { ctrl: true }); // parent Back, not provider filter
  await tui.sendKey("return");
  await tui.waitForText(/Step 1 of 5/);
  await tui.sendKey("return");
  await tui.sendKey("tab", { ctrl: true });
  await tui.sendKey("tab"); // Skip
  await tui.sendKey("return");
  await tui.waitForText(/Step 3 of 5/);
  await tui.waitForText(/deepseek-chat/);
  await tui.sendKey("tab", { ctrl: true });
  await tui.sendKey("tab");
  await tui.sendKey("tab"); // Next
  await tui.sendKey("return");
  await tui.waitForText(/Step 4 of 5/);
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
  await tui.waitForText(/Step 4 of 5/);
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
  await tui.sendKey("escape");
  await tui.sendKey("n", { ctrl: true }); // Skip Model back to Theme.
  expect(previewColors()).toEqual(original);
  expect(getSettings().theme).toBe(originalTheme);
  await tui.sendKey("right");
  await tui.sendKey("return");
  expect(getSettings().theme).not.toBe(originalTheme);
  await tui.sendKey("escape");
  expect(previewColors()).toEqual(draft);
});

test.each(["keyboard", "mouse"] as const)("%s cancellation unwinds credential entry before provider filters or wizard steps", async (input) => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKeys("anthropic");
  await tui.sendKey("return");
  await tui.waitForText(/Save/);
  expect(tui.captureFrame()).toContain("Paste your Anthropic API key.");
  expect(tui.captureFrame()).toContain("Hidden as you type. Saved");
  expect(tui.captureFrame()).toContain("owner-only on this machine.");
  expect(tui.captureFrame()).not.toContain("synthetic-unsaved-key");
  if (input === "mouse") await clickTopAction("Cancel");
  else await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 5/);
  expect(tui.captureFrame()).toMatch(/anthropic/i);
  // Filter mode then retained filter unwind locally before returning to Welcome.
  if (input === "mouse") await clickTopAction("Back");
  else await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 5/);
  if (input === "mouse") await clickTopAction("Back");
  else await tui.sendKey("escape");
  expect(tui.captureFrame()).not.toMatch(/Step 1 of 5/);
  if (input === "mouse") await clickTopAction("Back");
  else await tui.sendKey("escape");
  await tui.waitForText(/Step 1 of 5/);
});


test("top Continue authenticates the selected saved provider and advances to model selection", async () => {
  tui = await firstRun();
  await tui.sendKey("return");
  await tui.sendKeys("/deepseek");
  await tui.waitForText(/Continue/);
  await tui.sendKey("return");
  await tui.waitForText(/deepseek-chat/);
  await tui.sendKey("escape");
  await tui.waitForText(/Connections/);
});


test("rerun dismissal returns to chat without changing completion", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ ...modelsByokLaunch(), route: { type: "onboard" }, settings: { onboardingCompleted: true } });
  await tui.waitForText(/Step 1 of 5/);
  await tui.sendKey("escape");
  await tui.sendKeys("rerun draft");
  expect(tui.captureFrame()).toContain("rerun draft");
  expect(getSettings().onboardingCompleted).toBe(true);
});
