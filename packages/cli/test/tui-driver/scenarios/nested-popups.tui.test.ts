/**
 * Nested popups: the shared popup stack keeps only the TOP layer interactive.
 *
 * This drives `PopupStackProvider` (packages/cli/src/tui/popup-stack.tsx) in the
 * headless renderer with a minimal three-layer tree — a base screen that pushes
 * level A, which pushes level B — and asserts the load-bearing behaviour the
 * settings reset-confirm and the command palette both rely on:
 *
 *   1. pushing a popup layers it OVER the base without unmounting it (the base
 *      screen is still on screen underneath);
 *   2. only the TOP layer receives keys — the `keyHandler:null` trick makes
 *      every lower layer (base included) inert, so a keystroke lands on exactly
 *      one popup;
 *   3. Esc pops ONE level, revealing the layer beneath it, not the whole stack.
 *
 * Each layer renders a `keys=<n>` counter of the keystrokes IT received, so
 * "only the top responds" is a direct assertion: after two pushes, a keystroke
 * bumps only level B's counter, never level A's or the base's.
 *
 * The layers render plain markers rather than the `Popup` chrome — the stack's
 * focus/lifecycle mechanism is what is under test here; `Popup`'s geometry and
 * backdrop are unit-tested in popup.test.ts. Mounting the real `SettingsScreen`
 * to press `r` is not viable in this harness: an overlay screen's `useKeyboard`
 * does not subscribe under the headless renderer (reproducible on the untouched
 * baseline), so its keys never arrive — a pre-existing harness limitation. This
 * file, like `driver.ts`, is plain `.ts` and builds its tree with
 * `React.createElement` (the scenario runner does not transform JSX).
 */

import React, { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";

import { PopupStackProvider, usePopupStack, type PopupEntryApi } from "../../../src/tui/popup-stack.js";

const h = React.createElement;

/** A real macrotask tick: the reconciler commits asynchronously, so a flush
 *  alone does not paint the first frame — a tick between render and flush does. */
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// A minimal three-layer app built on the real PopupStackProvider.
// ---------------------------------------------------------------------------

function LevelB({ api }: { api: PopupEntryApi }) {
  const [keys, setKeys] = useState(0);
  useKeyboard((key) => {
    if (key.name === "escape") return api.pop();
    setKeys((n) => n + 1);
  });
  return h("text", null, `LEVEL-B keys=${keys}`);
}

function LevelA({ api }: { api: PopupEntryApi }) {
  const [keys, setKeys] = useState(0);
  useKeyboard((key) => {
    if (key.name === "escape") return api.pop();
    if (key.name === "2") return void api.push((child) => h(LevelB, { api: child }));
    setKeys((n) => n + 1);
  });
  return h("text", null, `LEVEL-A keys=${keys}`);
}

function Base() {
  const { push } = usePopupStack();
  const [keys, setKeys] = useState(0);
  useKeyboard((key) => {
    if (key.name === "1") return void push((api) => h(LevelA, { api }));
    setKeys((n) => n + 1);
  });
  return h("text", null, `BASE keys=${keys}`);
}

function App() {
  return h(
    "box",
    { width: "100%", height: "100%", flexDirection: "column" },
    h(PopupStackProvider, null, h(Base)),
  );
}

// ---------------------------------------------------------------------------
// Harness: mount the tree onto the headless renderer (mirrors the tolerant
// teardown the shared driver uses).
// ---------------------------------------------------------------------------

interface Mounted {
  frame: () => string;
  press: (key: string) => Promise<void>;
  escape: () => Promise<void>;
  close: () => Promise<void>;
}

async function mount(): Promise<Mounted> {
  const setup: TestRendererSetup = await createTestRenderer({ width: 60, height: 12 });

  const rendererRoot = setup.renderer.root as { remove: (child: unknown) => unknown };
  const originalRemove = rendererRoot.remove.bind(rendererRoot);
  rendererRoot.remove = (child: unknown) => {
    try {
      return originalRemove(child);
    } catch (error) {
      if (error instanceof Error && /renderable child/.test(error.message)) return undefined;
      throw error;
    }
  };

  const root = createRoot(setup.renderer);
  root.render(h(App));
  await tick();
  await setup.flush();

  return {
    frame: () => setup.captureCharFrame(),
    async press(key: string) {
      setup.mockInput.pressKey(key);
      await tick();
      await setup.flush();
    },
    async escape() {
      setup.mockInput.pressEscape();
      await tick(40);
      await setup.flush();
      await tick(40);
      await setup.flush();
    },
    async close() {
      try {
        root.unmount();
        await setup.flush();
      } catch {
        /* teardown throws are swallowed by the tolerant remove above */
      }
      try {
        setup.renderer.destroy();
      } catch {
        /* best-effort */
      }
    },
  };
}

let app: Mounted | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

test("push layers over the base, only the top responds, Esc pops one level", async () => {
  app = await mount();

  // Level 0: just the base screen.
  expect(app.frame()).toContain("BASE keys=0");
  expect(app.frame()).not.toContain("LEVEL-A");
  expect(app.frame()).not.toContain("LEVEL-B");

  // Push level A: it layers OVER the base, which stays mounted underneath.
  await app.press("1");
  expect(app.frame()).toContain("LEVEL-A keys=0");
  expect(app.frame()).toContain("BASE keys=0"); // base still there, underneath

  // Push level B from within A (a second level — real nesting).
  await app.press("2");
  expect(app.frame()).toContain("LEVEL-B keys=0");
  expect(app.frame()).toContain("LEVEL-A keys=0");
  expect(app.frame()).toContain("BASE keys=0");

  // A plain keystroke lands on the TOP layer only.
  await app.press("x");
  let frame = app.frame();
  expect(frame).toContain("LEVEL-B keys=1"); // top received it
  expect(frame).toContain("LEVEL-A keys=0"); // lower layer inert
  expect(frame).toContain("BASE keys=0"); // base inert

  // Esc pops exactly ONE level: B goes, A is revealed and becomes interactive.
  await app.escape();
  frame = app.frame();
  expect(frame).not.toContain("LEVEL-B");
  expect(frame).toContain("LEVEL-A keys=0");
  expect(frame).toContain("BASE keys=0");

  // A now responds again (it is the top), proving focus returned to it.
  await app.press("x");
  frame = app.frame();
  expect(frame).toContain("LEVEL-A keys=1");
  expect(frame).toContain("BASE keys=0");

  // Esc again pops A: back to the bare base, which is interactive once more.
  await app.escape();
  frame = app.frame();
  expect(frame).not.toContain("LEVEL-A");
  expect(frame).toContain("BASE keys=0");

  await app.press("x");
  expect(app.frame()).toContain("BASE keys=1");
});
