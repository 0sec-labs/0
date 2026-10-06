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
import { buildModelRows } from "../../../src/tui/model-layout.js";
import { providerStates } from "../../../src/tui/provider-status.js";
import { highlightedRow, modelLabel, modelsByokLaunch } from "./_helpers.js";

function stableModelLabel(rowText: string): string {
  return modelLabel(rowText).replace(/(?:…|\.\.\.)$/, "");
}

function selectedModelIdentity(frame: ReturnType<TuiHandle["captureSpans"]>): string {
  return stableModelLabel(highlightedRow(frame).text);
}

let tui: TuiHandle | undefined;

afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("arrow keys move one model at a time and retain selection through resize and action rows", async () => {
  tui = await launch(modelsByokLaunch());
  await tui.waitForText(/DEEPSEEK/, 15_000);
  await tui.settle();

  const start = highlightedRow(tui.captureSpans());
  expect(start.index, "no highlighted row at start").toBeGreaterThanOrEqual(0);
  expect(start.text, "highlighted row carries no model").toMatch(/DeepSeek|deepseek/i);

  await tui.sendKey("down");
  const afterOneDown = highlightedRow(tui.captureSpans());
  expect(afterOneDown.text, "Down did not select the next row").not.toBe(start.text);
  await tui.sendKey("up");
  expect(highlightedRow(tui.captureSpans()).text, "Up did not return to the starting row").toBe(start.text);

  for (let i = 0; i < 3; i += 1) await tui.sendKey("down");
  const afterDown = highlightedRow(tui.captureSpans());
  expect(afterDown.text, "a different model row is not highlighted").not.toBe(start.text);
  expect(afterDown.index, "highlight did not move down the list").toBeGreaterThan(start.index);

  for (let i = 0; i < 3; i += 1) await tui.sendKey("up");
  expect(highlightedRow(tui.captureSpans()).text, "up did not retreat to the starting model").toBe(start.text);

  await tui.sendKey("home");
  const firstModel = highlightedRow(tui.captureSpans());
  await tui.sendKey("end");
  expect(highlightedRow(tui.captureSpans()).text).toMatch(/Connect another provider/i);
  await tui.sendKey("down");
  const afterAction = highlightedRow(tui.captureSpans());
  expect(stableModelLabel(afterAction.text)).toBe(stableModelLabel(firstModel.text));
  const selectedBeforeResize = selectedModelIdentity(tui.captureSpans());
  await tui.resize(64, 24);
  expect(selectedModelIdentity(tui.captureSpans())).toBe(selectedBeforeResize);
  await tui.sendKey("down");
  expect(selectedModelIdentity(tui.captureSpans())).not.toBe(selectedBeforeResize);
  await tui.sendKey("up");
  expect(selectedModelIdentity(tui.captureSpans())).toBe(selectedBeforeResize);
});

test("catalog growth preserves a selected same-id model's provider identity", () => {
  const states = providerStates({
    OPENAI_API_KEY: "test-openai-key",
    AZURE_OPENAI_API_KEY: "test-azure-key",
    AZURE_OPENAI_BASE_URL: "https://azure.invalid",
  });
  const initial = buildModelRows({
    catalog: [{ id: "gpt-6-luna", provider: "openai", price: "$1" }],
    states,
    activeModel: "gpt-6-luna",
    activeProvider: "openai",
  });
  const selected = initial.find((row) => row.kind === "model" && row.active);
  expect(selected?.kind === "model" ? selected.group.id : undefined).toBe("openai");

  const hydrated = buildModelRows({
    catalog: [
      { id: "gpt-6-luna", provider: "openai", price: "$1" },
      { id: "gpt-6-luna", provider: "azure", price: "$1" },
    ],
    states,
    activeModel: selected?.kind === "model" ? selected.model.id : undefined,
    activeProvider: selected?.kind === "model" ? selected.group.id : undefined,
  });
  const choices = hydrated.filter((row) => row.kind === "model" && row.model.id === "gpt-6-luna");
  expect(choices).toHaveLength(2);
  expect(choices.map((row) => row.kind === "model" ? row.group.id : "")).toEqual(
    expect.arrayContaining(["openai", "azure"]),
  );
  expect(choices.find((row) => row.kind === "model" && row.active)?.group.id).toBe("openai");
});

test.each([[100, 34], [40, 12]])("embedded onboarding model navigation stays explicit at %ix%i", async (cols, rows) => {
  const fixture = modelsByokLaunch();
  tui = await launch({
    ...fixture,
    route: { type: "onboard" },
    cols,
    rows,
    settings: { onboardingCompleted: false, mouseSupport: true },
  });
  await tui.waitForText(/Step 1 of 5/);
  await tui.sendKey("return");
  await tui.waitForText(/Step 2 of 5/);
  await tui.sendKey("n", { ctrl: true });
  await tui.waitForText(/DEEPSEEK|deepseek/i, 15_000);

  const original = highlightedRow(tui.captureSpans());
  await tui.sendKey("down");
  const moved = highlightedRow(tui.captureSpans());
  expect(stableModelLabel(moved.text)).not.toBe(stableModelLabel(original.text));
  expect(tui.captureFrame()).toContain("Step 3 of 5");

  const afterResize = highlightedRow(tui.captureSpans());
  expect(stableModelLabel(afterResize.text)).toBe(stableModelLabel(moved.text));
  await tui.sendKey("down");
  expect(stableModelLabel(highlightedRow(tui.captureSpans()).text)).not.toBe(stableModelLabel(afterResize.text));
  expect(tui.captureFrame()).toContain("Step 3 of 5");

  // Browsing never applies a model. Reopening the step still highlights the
  // runtime's saved model, not the last row merely visited with an arrow.
  await tui.sendKey("escape");
  await tui.waitForText(/Step 2 of 5/);
  await tui.sendKey("n", { ctrl: true });
  await tui.waitForText(/Step 3 of 5/);
  const reopened = highlightedRow(tui.captureSpans());
  const originalLabel = stableModelLabel(original.text);
  expect(stableModelLabel(reopened.text).startsWith(originalLabel)).toBe(true);
});

test("agent chat selection preserves a model-command draft and composer editing", async () => {
  tui = await launch({
    ...modelsByokLaunch(),
    route: { type: "chat" },
    env: { ...modelsByokLaunch().env, OSEC_TUI_DEMO_AGENTS: "1" },
    settings: { reduceMotion: true },
  });
  await tui.waitForText(/recon web tier/, 15_000);

  // Idle-composer arrows navigate workers without a focus chord. Down enters
  // the first worker, Down advances, and Up retreats before Up returns to Main.
  await tui.sendKey("down");
  await tui.waitForText(/to recon web tier · \[Esc\] restores Main draft/);
  await tui.sendKey("down");
  await tui.waitForText(/to auth & session fuzzing · \[Esc\] restores Main draft/);
  await tui.sendKey("up");
  await tui.waitForText(/to recon web tier · \[Esc\] restores Main draft/);
  await tui.sendKey("up");
  expect(tui.captureFrame()).not.toContain("to recon web tier · [Esc] restores Main draft");
  // A further Down from Main returns to the first worker; this distinguishes
  // the Main boundary from merely remaining focused on the first worker.
  await tui.sendKey("down");
  await tui.waitForText(/to recon web tier · \[Esc\] restores Main draft/);
  await tui.sendKey("up");
  expect(tui.captureFrame()).not.toContain("to recon web tier · [Esc] restores Main draft");
  await tui.sendKeys("/model");
  await tui.waitForText(/\/model · 1/);
  expect(tui.captureFrame()).toContain("open picker");

  // A live command draft survives switching to a worker and back to Main.
  await tui.sendKey("g", { ctrl: true });
  await tui.waitForText(/to recon web tier · \[Esc\] restores Main draft/);
  await tui.sendKey("home", { ctrl: true, shift: true });
  expect(tui.captureFrame()).not.toContain("to recon web tier · [Esc] restores Main draft");
  expect(tui.captureFrame()).toContain("/model");

  // The draft survives worker navigation. Left moves the visible caret,
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



test("explicit Connections selection survives asynchronous model discovery", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const options = modelsByokLaunch();
  tui = await launch({ ...options, fetchImpl: async (input, init) => {
    if (String(input) === "https://api.deepseek.com/models") await pending;
    return options.fetchImpl!(input, init);
  } });
  await tui.waitForText(/Connect another provider/);
  await tui.sendKey("end");
  expect(highlightedRow(tui.captureSpans()).text).toMatch(/Connect another provider/);
  release();
  await tui.waitForText(/per M/);
  expect(highlightedRow(tui.captureSpans()).text).toMatch(/Connect another provider/);
  await tui.sendKey("home");
  expect(highlightedRow(tui.captureSpans()).text).toMatch(/deepseek-chat/);
});
