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

/**
 * A REAL macrotask tick.
 *
 * OpenTUI's React reconciler commits, and React runs passive effects
 * (`useEffect`), on a macrotask — NOT synchronously inside `setup.flush()`,
 * which only drives native render passes. A component's `useKeyboard`/`usePaste`
 * subscription is a passive effect (`keyHandler.on("keypress", …)`), so until a
 * real macrotask runs, a freshly-mounted screen — the initial route, and any
 * route/overlay that mounts mid-scenario — has NOT yet attached its key handler
 * and silently drops input. Yielding a macrotask before delivering input (and
 * again after, so the state update paints) is what makes overlay-screen
 * keyboard drivable headlessly. See `settleInput` below and the driver header.
 */
function macrotask(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A lone Escape arrives as a bare ESC byte, and the terminal input parser holds
 * it back briefly to disambiguate it from an escape SEQUENCE (arrows, function
 * keys) that starts with the same byte. It only surfaces as a "escape" keypress
 * after that parser timeout elapses, so an Esc needs a longer settle than a
 * printable key. ~40ms matches the parser's flush window.
 */
const ESCAPE_SETTLE_MS = 40;

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
  /**
   * Move the mouse pointer to a cell (0-based col `x`, row `y`), firing the
   * hover/move handlers (`onMouseOver`, `onMouseMove`) of the renderable under
   * it. The pointer is remembered, so a follow-up hover at the SAME cell is a
   * no-op the way a real terminal reports it — which is exactly the condition
   * the list's hover-vs-scroll guard keys on.
   */
  moveMouse(x: number, y: number): Promise<void>;
  /** Left-click a cell (0-based), firing the `onMouseDown` of the renderable under it. */
  click(x: number, y: number): Promise<void>;
  /**
   * Scroll the wheel over a cell (0-based). `deltaRows` is signed: NEGATIVE
   * scrolls up (toward the top), POSITIVE scrolls down; its magnitude is the
   * number of wheel notches delivered. The pointer does not move, so this
   * exercises exactly the wheel-over-a-stationary-cursor path.
   */
  scroll(x: number, y: number, deltaRows: number): Promise<void>;
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
  // The extra macrotask is what lets React run the passive effects that ATTACH
  // the mounted screen's `useKeyboard`/`usePaste` subscriptions — without it the
  // very first keystroke lands before any handler is listening. See `macrotask`.
  await setup.flush();
  await macrotask();
  await setup.flush();

  /**
   * Bridge the module-duplicated `Renderable.renderablesByNumber` maps so mouse
   * dispatch can resolve a hit to its handler.
   *
   * Under vitest + Bun, `@opentui/react` (the reconciler that CREATES the
   * renderables and attaches their `onMouseOver`/`onMouseDown`/`onMouseScroll`
   * handlers) resolves a SEPARATE copy of `@opentui/core` from the one
   * `@opentui/core/testing` builds the renderer with. `Renderable` is a class
   * with a STATIC `renderablesByNumber` map, so each copy keeps its own: the
   * reconciler registers its renderables in copy A's map, while the renderer's
   * mouse dispatch (`processSingleMouseEvent`) looks the hit id up in copy B's.
   * The native hit grid (shared via the renderer pointer) still returns the
   * right id, but `renderablesByNumber.get(id)` in copy B is empty, so
   * `maybeRenderable` is undefined and NO handler fires. Keyboard/paste are
   * unaffected — they dispatch through `renderer.keyInput`, not this map.
   *
   * The fix, entirely driver-side: before delivering a mouse event, walk the
   * live tree (the renderables ARE the reconciler's objects, reachable through
   * `renderer.root`) and register each into the RENDERER's copy of the map by
   * its `num`. Dispatch then resolves the id to the real renderable and calls
   * its listeners. Re-run before every mouse event so a freshly mounted /
   * re-laid-out tree stays covered; stale entries are harmless because the hit
   * grid never returns an id for a renderable that is no longer painted.
   */
  const rendererRenderableClass = Object.getPrototypeOf(setup.renderer.root)
    .constructor as { renderablesByNumber?: Map<number, unknown> };
  function syncRenderablesForMouse(): void {
    const map = rendererRenderableClass.renderablesByNumber;
    if (!map) return;
    // Primary path: copy the reconciler copy's OWN map wholesale. That copy
    // holds every renderable it created — crucially the ones nested inside a
    // scrollbox's viewport, which a `getChildren` tree-walk does not reach
    // (the list rows in the model picker live there). Find that class through
    // any live child of the root: its prototype's constructor is the reconciler
    // copy, distinct from the renderer's own.
    for (const child of (setup.renderer.root.getChildren?.() ?? []) as unknown[]) {
      const reconClass = Object.getPrototypeOf(child).constructor as {
        renderablesByNumber?: Map<number, unknown>;
      };
      if (reconClass !== rendererRenderableClass && reconClass.renderablesByNumber) {
        for (const [num, rn] of reconClass.renderablesByNumber) map.set(num, rn);
        break;
      }
    }
    // Belt-and-suspenders: also register everything reachable by walking the
    // tree, covering any renderable a copy's map might have missed.
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const rn = node as { num?: number; getChildren?: () => unknown[] };
      if (typeof rn.num === "number") map.set(rn.num, rn);
      for (const child of rn.getChildren?.() ?? []) walk(child);
    };
    walk(setup.renderer.root);
  }

  /**
   * Deliver synthetic input, then settle.
   *
   * `pre` runs on the current tree; a macrotask before it guarantees that a
   * screen mounted by the PREVIOUS input (a route change, a pushed overlay) has
   * had its key/paste subscription attached before this input is emitted.
   * `escape` gets the longer parser-flush window; every input then paints.
   */
  async function settleInput(pre: () => void | Promise<void>, escape = false): Promise<void> {
    await macrotask();
    await setup.flush();
    await pre();
    // Settle in SEVERAL macrotask+flush rounds, not one. The handler's React
    // state update commits on a macrotask (the reconciler is async), and the
    // committed tree only paints on the NEXT flush — so a single round can
    // capture the pre-update frame. This bites hardest right after a mouse
    // event, whose own async stdin drain shifts the timing enough that one
    // round intermittently misses the keyboard update's paint. A few rounds
    // (each a real macrotask) let commit-then-paint fully drain; the settle
    // window is longer for Esc, which the stdin parser releases late.
    const rounds = escape ? 3 : 2;
    for (let i = 0; i < rounds; i += 1) {
      await macrotask(escape ? ESCAPE_SETTLE_MS : 0);
      await setup.flush();
    }
  }

  const handle: TuiHandle = {
    async sendKeys(str) {
      await settleInput(() => setup.mockInput.typeText(str));
    },
    async sendKey(key, mods) {
      const lower = key.toLowerCase();
      const isEscape = lower === "escape" || lower === "esc";
      await settleInput(() => {
        const arrow = ARROWS[lower];
        if (arrow) setup.mockInput.pressArrow(arrow, mods);
        else if (lower === "enter" || lower === "return") setup.mockInput.pressEnter(mods);
        else if (isEscape) setup.mockInput.pressEscape(mods);
        else if (lower === "tab") setup.mockInput.pressTab(mods);
        else if (lower === "backspace") setup.mockInput.pressBackspace(mods);
        else setup.mockInput.pressKey(key, mods);
      }, isEscape);
    },
    async sendPaste(text) {
      await settleInput(() => setup.mockInput.pasteBracketedText(text));
    },
    async moveMouse(x, y) {
      await settleInput(() => {
        syncRenderablesForMouse();
        return setup.mockMouse.moveTo(x, y);
      });
    },
    async click(x, y) {
      await settleInput(() => {
        syncRenderablesForMouse();
        return setup.mockMouse.click(x, y);
      });
    },
    async scroll(x, y, deltaRows) {
      const direction = deltaRows < 0 ? "up" : "down";
      const notches = Math.max(1, Math.abs(deltaRows));
      await settleInput(async () => {
        syncRenderablesForMouse();
        for (let i = 0; i < notches; i += 1) await setup.mockMouse.scroll(x, y, direction);
      });
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
