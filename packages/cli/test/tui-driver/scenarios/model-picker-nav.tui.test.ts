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
 * The list is pinned to the deterministic BYOK catalogue (`modelsByokLaunch`)
 * so the rows are stable and present from first paint — the picker otherwise
 * flips to an empty hosted catalogue asynchronously offline. The highlighted
 * row is read straight from the rendered spans (`highlightedRow`): pressing
 * "down" moves the highlight to a later row and "up" retreats to exactly where
 * it started. If the settle-tick regresses (or the overlay stops subscribing),
 * the highlight never moves and this fails.
 */

import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { highlightedRow, modelsByokLaunch } from "./_helpers.js";
import type * as ModelCatalogSync from "../../../src/tui/model-catalog-sync.js";

vi.mock("../../../src/tui/model-catalog-sync.js", async (importOriginal) => {
  const original = await importOriginal<typeof ModelCatalogSync>();
  return {
    ...original,
    loadHostedModelCatalog: (opts: Parameters<typeof original.loadHostedModelCatalog>[0]) =>
      opts?.env?.ZERO_CLOUD_TOKEN === "picker-fixture-token"
        ? Promise.resolve({
            host: "https://fixture.0.security",
            fetchedAt: Date.now(),
            models: [{
              id: "auto",
              object: "model" as const,
              owned_by: "0security",
              provider: "openai",
              upstream_model: "hidden",
              wire_api: "responses" as const,
              context_length: 128000,
              max_output_tokens: 8192,
              pricing: { input_per_million_usd: 0, output_per_million_usd: 0, cached_input_per_million_usd: 0 },
            }],
          })
        : original.loadHostedModelCatalog(opts),
  };
});

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("arrow keys scroll the model list; up retreats to the start", async () => {
  tui = await launch(modelsByokLaunch());
  await tui.waitForText(/DEEPSEEK/, 15_000);
  await tui.settle();

  const start = highlightedRow(tui.captureSpans());
  expect(start.index, "no highlighted row at start").toBeGreaterThanOrEqual(0);
  expect(start.text, "highlighted row carries no model").toMatch(/DeepSeek|deepseek/i);

  // Press "down" several times: a LATER row (further down the list) becomes the
  // active one. The model TEXT is the stable identity — the screen line index
  // can shift a row when a status/detail line reflows, so nav is asserted on the
  // highlighted model, with the line index only as a coarse "moved down" check.
  for (let i = 0; i < 3; i += 1) await tui.sendKey("down");
  const afterDown = highlightedRow(tui.captureSpans());

  expect(afterDown.text, "a different model row is not highlighted").not.toBe(start.text);
  expect(afterDown.index, "highlight did not move down the list").toBeGreaterThan(start.index);

  // Press "up" the same number of times: the highlight retreats to the model it
  // started on.
  for (let i = 0; i < 3; i += 1) await tui.sendKey("up");
  const afterUp = highlightedRow(tui.captureSpans());

  expect(afterUp.text, "up did not retreat to the starting model").toBe(start.text);
});

test("hosted Auto and connected API models share one picker without a second auto row", async () => {
  tui = await launch({
    ...modelsByokLaunch(),
    env: {
      ZERO_CLOUD_TOKEN: "picker-fixture-token",
      ZERO_PROVIDER: "hosted",
      ZERO_MODEL: "auto",
      OPENAI_API_KEY: "openai-fixture",
      DEEPSEEK_API_KEY: "deepseek-fixture",
      AZURE_OPENAI_API_KEY: "azure-fixture",
      AZURE_OPENAI_BASE_URL: "https://azure.example.test/openai/v1",
    },
  });
  await tui.waitForText(/0security Auto/);
  const frame = tui.captureFrame();
  expect(frame).toContain("0security Auto");
  expect(frame).toContain("DEEPSEEK");
  expect(frame).toContain("OPENAI");
  expect(frame).toContain("AZURE OPENAI");
  expect(frame).not.toMatch(/\bHOSTED\b/);
  expect(frame).not.toMatch(/^\s*auto\s*$/m);
  await tui.sendKey("down");
  const selected = highlightedRow(tui.captureSpans());
  expect(selected.text).toMatch(/DeepSeek/i);
  await tui.sendKey("return");
  await tui.sendKeys("/model");
  await tui.sendKey("return");
  await tui.waitForText(/Target: parent.*DeepSeek-V4-Flash/);
  expect(highlightedRow(tui.captureSpans()).text).toMatch(/DeepSeek/i);
});
