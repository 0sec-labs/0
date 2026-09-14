/**
 * In-process TUI driver.
 *
 * Mounts the real console (`UnifiedApp`) into OpenTUI's HEADLESS test renderer —
 * no node-pty, no tmux, no alternate-screen — so a scenario can drive the app
 * with synthetic keystrokes and read back rendered character frames entirely
 * inside a vitest worker. This is the closed-loop counterpart to the pentest
 * harness: fast, deterministic, and free of a real terminal.
 *
 * Why mount `UnifiedApp` directly instead of the shipping `mountApp`:
 * `mountApp` installs the TUI output guard and drives an alternate-screen
 * `createCliRenderer`, both of which patch the worker's real stdout. The test
 * renderer already owns a virtual framebuffer, so we mount the component tree
 * onto it and leave the worker's streams untouched.
 */

import React from "react";
import { expect } from "vitest";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { UnifiedApp } from "../../src/tui/run.js";
import {
  configureSettingsStore,
  __resetSettingsStoreForTests,
} from "../../src/tui/settings-store.js";
import { withDeterministicEnv } from "./env.js";
import { normalizeFrame } from "./normalize.js";

/** The console-mode routes `UnifiedApp` understands, recovered from its props. */
type UnifiedMode = React.ComponentProps<typeof UnifiedApp>["mode"];
type ConsoleMode = Extract<UnifiedMode, { type: "console" }>;
export type ConsoleRoute = ConsoleMode["initialRoute"];

/** Modifier flags accepted by the mock keyboard. */
export interface KeyModifiers {
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
  hyper?: boolean;
}

export interface LaunchOptions {
  /** Terminal columns. */
  cols?: number;
  /** Terminal rows. */
  rows?: number;
  /** Initial route; defaults to the persistent chat/home screen. */
  route?: ConsoleRoute;
  /** Extra `process.env` overrides applied for this launch and restored on close. */
  env?: Record<string, string | undefined>;
  /** Settings-file overrides merged into the seeded `tui-settings.json`. */
  settings?: Record<string, unknown>;
}

export interface TuiHandle {
  /** Type a run of printable characters (e.g. "/" to open the command menu). */
  sendKeys(str: string): Promise<void>;
  /** Press a single named key (arrows, "return", "escape", …) with optional modifiers. */
  sendKey(key: string, mods?: KeyModifiers): Promise<void>;
  /** Deliver a bracketed paste, exercising the composer's paste-chip path. */
  sendPaste(text: string): Promise<void>;
  /** Resize the virtual terminal. */
  resize(cols: number, rows: number): Promise<void>;
  /** Wait until a rendered (normalized) frame matches `re`; resolves with that frame. */
  waitForText(re: RegExp, timeoutMs?: number): Promise<string>;
  /** The current frame, normalized for stable comparison. */
  captureFrame(): string;
  /** The current frame, exactly as rendered. */
  rawFrame(): string;
  /** Assert the current normalized frame against a named vitest snapshot. */
  snapshot(name: string): void;
  /** Access the raw captured spans (per-cell fg/bg/text) of the current frame. */
  captureSpans(): ReturnType<TestRendererSetup["captureSpans"]>;
  /** Settle animations/effects: wait for visual idle, then flush a frame. */
  settle(): Promise<void>;
  /** Unmount, tear down the renderer, and restore env + settings store. */
  close(): Promise<void>;
}

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

/** Clone a RegExp without the sticky/global flag so repeated `.test()` is stateless. */
function stateless(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
}

export async function launch(opts: LaunchOptions = {}): Promise<TuiHandle> {
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 34;

  const deterministic = withDeterministicEnv(opts.settings);

  // Extra per-launch env overrides, snapshotted so close() restores them too.
  const envPrior = new Map<string, string | undefined>();
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      envPrior.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // Point the process-wide settings store at the throwaway home BEFORE mounting,
  // so the first `useSettings()` read resolves the seeded file, not the real one.
  configureSettingsStore({ homeDir: deterministic.homeDir, projectDir: deterministic.homeDir });

  const setup = await createTestRenderer({ width: cols, height: rows });

  // OpenTUI's React reconciler tears the tree down with
  // `clearContainer → root.getChildren().forEach(c => root.remove(c))`, and
  // `remove` THROWS ("remove expects a renderable child object") on a child
  // that is no longer a live renderable — an uncaught exception in a scheduler
  // task that no try/catch around unmount() can see, which fails the run. The
  // removal is still the right outcome, so make this one root's `remove`
  // tolerant: swallow exactly that error and let every other propagate.
  const rendererRoot = setup.renderer.root as {
    remove: (child: unknown) => unknown;
  };
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

  const mode = {
    type: "console" as const,
    initialRoute: opts.route ?? { type: "chat" as const },
    // The app calls onExit on a requested quit; in-process there is no process
    // to exit, so this is a no-op — close() does the real teardown.
    onExit: () => {},
  } satisfies ConsoleMode;

  root.render(React.createElement(UnifiedApp, { mode }));

  // Let mount effects (plugin-host prep, workspace bootstrap) run and paint.
  await setup.flush();

  const handle: TuiHandle = {
    async sendKeys(str) {
      await setup.mockInput.typeText(str);
      await setup.flush();
    },
    async sendKey(key, mods) {
      const arrow = ARROWS[key.toLowerCase()];
      if (arrow) setup.mockInput.pressArrow(arrow, mods);
      else if (key.toLowerCase() === "enter" || key.toLowerCase() === "return")
        setup.mockInput.pressEnter(mods);
      else if (key.toLowerCase() === "escape" || key.toLowerCase() === "esc")
        setup.mockInput.pressEscape(mods);
      else if (key.toLowerCase() === "tab") setup.mockInput.pressTab(mods);
      else if (key.toLowerCase() === "backspace") setup.mockInput.pressBackspace(mods);
      else setup.mockInput.pressKey(key, mods);
      await setup.flush();
    },
    async sendPaste(text) {
      await setup.mockInput.pasteBracketedText(text);
      await setup.flush();
    },
    async resize(c, r) {
      setup.resize(c, r);
      await setup.flush();
    },
    async waitForText(re, timeoutMs = 5000) {
      const probe = stateless(re);
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      for (;;) {
        await setup.flush();
        const frame = normalizeFrame(setup.captureCharFrame());
        if (probe.test(frame)) return frame;
        if (Date.now() > deadline) {
          throw new Error(
            `waitForText timed out after ${timeoutMs}ms waiting for ${re}\n` +
              `---- last frame ----\n${frame}\n--------------------`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    captureFrame() {
      return normalizeFrame(setup.captureCharFrame());
    },
    rawFrame() {
      return setup.captureCharFrame();
    },
    snapshot(name) {
      expect(normalizeFrame(setup.captureCharFrame())).toMatchSnapshot(name);
    },
    captureSpans() {
      return setup.captureSpans();
    },
    async settle() {
      await setup.waitForVisualIdle();
      await setup.flush();
    },
    async close() {
      try {
        root.unmount();
        await setup.flush();
      } catch {
        // Unmount errors on the way out must not mask a test result (the
        // tolerant root.remove above absorbs the reconciler's teardown throw).
      }
      try {
        setup.renderer.destroy();
      } catch {
        // Same: destroy is best-effort teardown.
      }
      // Restore per-launch env, the deterministic env, and the settings store.
      for (const [key, value] of envPrior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      deterministic.restore();
      __resetSettingsStoreForTests();
    },
  };

  return handle;
}
