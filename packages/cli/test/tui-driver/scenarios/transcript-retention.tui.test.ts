import React from "react";
import type * as CoreTesting from "@opentui/core/testing";
import type { Renderable } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { expect, test, vi } from "vitest";
import { renderEntry } from "../../../src/tui/chat/TranscriptEntry.js";
import type { EntryDisplay } from "../../../src/tui/chat/types.js";
import { SessionScreen } from "../../../src/tui/session-screen.js";
import { createInitialSessionState } from "../../../src/tui/session-state.js";
import { TranscriptReviewRenderable } from "../../../src/tui/transcript-review-renderable.js";
import { MAX_REVIEW_CHARS } from "../../../src/tui/transcript-review.js";
import { getTheme } from "../../../src/tui/themes.js";
import {
  configureSettingsStore,
  __resetSettingsStoreForTests,
} from "../../../src/tui/settings-store.js";
import { withDeterministicEnv } from "../env.js";

// Static imports cannot select Bun's native ABI through Vitest's SSR resolver.
// Load the real runtime core so custom renderables share React's class identity.
vi.mock("@opentui/core", async () => {
  const entry = new URL(
    process.versions.bun ? "./index.bun.js" : "./index.node.js",
    import.meta.resolve("@opentui/core"),
  );
  return import(entry.href);
});

async function mount(node: React.ReactNode) {
  const environment = withDeterministicEnv();
  configureSettingsStore({ homeDir: environment.homeDir, projectDir: environment.homeDir });
  const testingEntry = new URL(
    process.versions.bun ? "./testing.bun.js" : "./testing.js",
    import.meta.resolve("@opentui/core"),
  );
  const { createTestRenderer } = await import(testingEntry.href) as typeof CoreTesting;
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const root = createRoot(setup.renderer);
  const settle = async () => {
    // Fake timers cannot drive the external native/React scheduler; its input
    // subscriptions need real macrotasks, not an assumed wall-clock delay.
    for (let round = 0; round < 2; round++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await setup.flush();
    }
  };
  const close = async () => {
    try {
      root.unmount();
      await settle();
    } finally {
      setup.renderer.destroy();
      __resetSettingsStoreForTests();
      environment.restore();
    }
  };
  try {
    root.render(React.createElement("box", {
      flexDirection: "column", width: "100%", height: "100%",
    }, node));
    await settle();
    return { setup, settle, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test("plain assistant and reasoning fallbacks preserve code lines and indentation", async () => {
  const theme = getTheme("blue-team");
  const display: EntryDisplay = {
    spacing: 0, showTimestamps: false, now: 0,
    transcriptStyle: "document", roleLabelStyle: "off", toolCardStyle: "rail",
    mode: "Standard", modeColor: theme.PRIMARY, model: "",
    modelInFooter: false, showTokenUsage: false, showCost: false,
    transcriptDetail: "expanded", richMarkdown: false,
  };
  const source = "\u001b[31m```python\nif ok:\n    act()\nelse:\n    stop()\n```\u001b[0m";
  const view = await mount(React.createElement(React.Fragment, null,
    renderEntry({ id: "answer", kind: "assistant", text: source, turn: 1 }, 100, display, theme),
    renderEntry({ id: "reasoning", kind: "reasoning", text: source, turn: 1 }, 100, display, theme),
  ));
  try {
    const frame = view.setup.captureCharFrame();
    const lines = frame.split("\n");
    const starts = lines.flatMap((line, index) => line.includes("if ok:") ? [index] : []);
    expect(starts).toHaveLength(2);
    for (const index of starts) {
      const column = lines[index].indexOf("if ok:");
      expect(lines[index + 1].indexOf("act()")).toBe(column + 4);
      expect(lines[index + 2].indexOf("else:")).toBe(column);
      expect(lines[index + 3].indexOf("stop()")).toBe(column + 4);
    }
    expect(frame).not.toContain("[31m");
    expect(frame).not.toContain("[0m");
  } finally {
    await view.close();
  }
});

test("SessionScreen native review stays bounded and navigates to the latest text", async () => {
  const state = createInitialSessionState("synthetic-target", "standard", "scan");
  state.transcript = [
    ...Array.from({ length: 60 }, (_, index) => ({
      id: `notice-${index}`, kind: "status" as const, turn: index + 1,
      text: `Earlier review ${index} ${"content ".repeat(300)}`,
    })),
    {
      id: "latest", kind: "error", turn: 61,
      text: `LATEST_REVIEW_HEAD\n${"terminal detail ".repeat(5_000)}\nNATIVE_REVIEW_TAIL`,
    },
  ];
  const view = await mount(React.createElement(SessionScreen, { state, onExit: () => {} }));
  try {
    view.setup.mockInput.pressKey("o", { ctrl: true });
    await view.settle();
    const pending: Renderable[] = [view.setup.renderer.root];
    let review: TranscriptReviewRenderable | undefined;
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node instanceof TranscriptReviewRenderable) {
        review = node;
        break;
      }
      pending.push(...node.getChildren());
    }
    // Observe the actual native buffer, not a mock of the review component.
    expect(review).toBeDefined();
    expect(review!.plainText.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS);
    expect(review!.plainText).toContain("earlier review lines hidden");
    expect(review!.plainText).toContain("LATEST_REVIEW_HEAD");
    expect(review!.plainText).toContain("NATIVE_REVIEW_TAIL");
    view.setup.mockInput.pressKey("END", { ctrl: true });
    await view.settle();
    expect(view.setup.captureCharFrame()).toContain("NATIVE_REVIEW_TAIL");
    view.setup.mockInput.pressKey("o", { ctrl: true });
    await view.settle();
    expect(view.setup.captureCharFrame()).not.toContain("TRANSCRIPT REVIEW");
  } finally {
    await view.close();
  }
});
