import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { loadCredentials, saveCredentials } from "../../../src/tui/credential-store.js";
import { PROVIDERS } from "../../../src/tui/provider-status.js";
import { getSettings } from "../../../src/tui/settings-store.js";
import { frameLines } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
  vi.restoreAllMocks();
});

const emptyProviderEnv = Object.fromEntries(PROVIDERS.flatMap((provider) =>
  provider.envVars.map((name) => [name, undefined]),
));

async function clickAction(label: string) {
  const lines = frameLines(tui!.rawFrame());
  const action = new RegExp(`\\b${label}\\b`);
  let y = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (action.test(lines[index] ?? "")) y = index;
  }
  expect(y, `${label} action is not visible`).toBeGreaterThanOrEqual(0);
  await tui!.click(lines[y]!.indexOf(label) + 1, y);
}

test("mouse Cancel preserves the existing key; mouse selection and keyboard Save preserve other providers", async () => {
  tui = await launch({ route: { type: "connect" }, cols: 100, rows: 34,
    env: emptyProviderEnv, settings: { onboardingCompleted: true, mouseSupport: true } });
  await tui.waitForText(/Search providers/);
  const home = process.env["HOME"]!;
  expect(saveCredentials({ anthropic: "existing-anthropic-key", openai: "existing-openai-key" }, home)).toBe(true);
  const lines = frameLines(tui.rawFrame());
  const y = lines.findIndex((line) => /OpenAI\s+API key/.test(line));
  expect(y).toBeGreaterThanOrEqual(0);
  await tui.click(lines[y]!.indexOf("OpenAI") + 1, y);
  await clickAction("Connect");
  await tui.waitForText(/Paste or type key/);
  await tui.sendPaste("unsaved-replacement-secret");
  await clickAction("Cancel");
  expect(loadCredentials(home)).toEqual({ anthropic: "existing-anthropic-key", openai: "existing-openai-key" });
  expect(tui.captureFrame()).not.toMatch(/Paste or type key|unsaved-replacement-secret/);
  await clickAction("Connect");
  const secret = "synthetic-openai-secret-never-display";
  await tui.sendPaste(secret);
  expect(tui.captureFrame()).toContain("••••••••");
  expect(tui.captureFrame()).not.toContain(secret);
  await tui.sendKey("tab");
  await tui.sendKey("tab");
  await tui.sendKey("return");
  expect(loadCredentials(home)).toEqual({ anthropic: "existing-anthropic-key", openai: secret });
});

test.each([[64, 24], [40, 12]])("compact embedded controls go back or advance without saving or completing setup (%ix%i)", async (cols, rows) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ route: { type: "onboard" }, cols, rows,
    env: { ...emptyProviderEnv, DEEPSEEK_API_KEY: "synthetic-existing-key", ZERO_PROVIDER: "deepseek", ZERO_MODEL: "deepseek-chat" },
    settings: { onboardingCompleted: false, mouseSupport: true } });
  await tui.waitForText(/Step 1 of 5/);
  await tui.sendKey("return");
  await tui.waitForText(/Step 2 of 5/);
  await clickAction("Back");
  await tui.waitForText(/Step 1 of 5/);
  await clickAction("Continue");
  await tui.sendKeys("/deepseek");
  await tui.waitForText(/Continue/);
  const before = loadCredentials(process.env["HOME"]!);
  await clickAction("Continue");
  await tui.waitForText(/●\s+deepseek-chat/);
  expect(loadCredentials(process.env["HOME"]!)).toEqual(before);
  expect(getSettings().onboardingCompleted).toBe(false);
});

test("embedded Connect opens the selected key form; Cancel does not persist a draft", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({ route: { type: "onboard" }, cols: 64, rows: 24,
    env: { ...emptyProviderEnv, DEEPSEEK_API_KEY: "synthetic-existing-key", ZERO_PROVIDER: "deepseek", ZERO_MODEL: "deepseek-chat" },
    settings: { onboardingCompleted: false, mouseSupport: true } });
  await tui.waitForText(/Step 1 of 5/);
  await tui.sendKey("return");
  await tui.sendKeys("/anthropic");
  await clickAction("Connect");
  await tui.waitForText(/Paste or type key/);
  expect(tui.captureFrame()).toContain("Step 2 of 5");
  await tui.sendPaste("unsaved-draft-key");
  await clickAction("Cancel");
  expect(tui.captureFrame()).toContain("Step 2 of 5");
  expect(loadCredentials(process.env["HOME"]!)).toEqual({});
  await clickAction("Connect");
  const secret = "synthetic-embedded-anthropic-key";
  await tui.sendPaste(secret);
  expect(tui.captureFrame()).not.toContain(secret);
  await clickAction("Save");
  await tui.waitForText(/claude-fable-5-1/);
  expect(loadCredentials(process.env["HOME"]!)).toEqual({ anthropic: secret });
  expect(getSettings().onboardingCompleted).toBe(false);
});
