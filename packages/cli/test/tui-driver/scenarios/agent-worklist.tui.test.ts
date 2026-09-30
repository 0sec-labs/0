import { setImmediate as settle } from "node:timers/promises";
import React from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { AgentWorkList } from "../../../src/tui/chat/AgentChatSwitcher.js";
import type { HerdSubagentMap } from "../../../src/tui/herd-layout.js";
import { getTheme } from "../../../src/tui/themes.js";
import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";
import { modelsByokLaunch } from "./_helpers.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("Main and subagents share the composer and full-width clickable task list", async () => {
  const options = modelsByokLaunch({ mouse: true });
  tui = await launch({ ...options, route: { type: "chat" }, cols: 100, rows: 34,
    env: { ...options.env, OSEC_TUI_DEMO_AGENTS: "1" }, settings: { ...options.settings, reduceMotion: true } });
  await tui.waitForText(/secret scanning/);
  expect(tui.rawFrame()).toMatch(/\b(?:\d+s|\d+m\d{2}s|\d+h\d{2}m)\b/);
  await tui.sendKeys("main draft");
  expect(tui.captureFrame()).toContain("recon web tier");
  expect(tui.captureFrame()).toContain("enumerating /api endpoints");
  expect(tui.captureFrame()).toContain("auth & session fuzzing");
  expect(tui.captureFrame()).toContain("cookie tampering");
  expect(tui.captureFrame()).toContain("secret scanning");
  expect(tui.captureFrame()).not.toContain("Spawn lineage");
  expect(tui.captureFrame()).not.toContain("TRANSCRIPT");

  const mainRows = tui.rawFrame().replace(/਀/g, " ").split("\n");
  const workerY = mainRows.findIndex((row) => row.includes("auth & session fuzzing"));
  expect(workerY).toBeGreaterThanOrEqual(0);
  await tui.click(mainRows[workerY]!.indexOf("auth & session fuzzing"), workerY);
  expect(tui.captureFrame()).toContain("to auth & session fuzzing");
  await tui.sendKeys("worker draft");
  expect(tui.captureFrame()).toContain("worker draft");
  await tui.sendKey("return");
  expect(tui.captureFrame()).toContain("to auth & session fuzzing");
  expect(tui.captureFrame()).toContain("worker draft");

  await tui.sendKey("down");
  expect(tui.captureFrame()).toContain("to secret scanning");
  // Ctrl+Shift+Home switches to Main without taking the composer/input out of service.
  await tui.sendKey("home", { ctrl: true, shift: true });
  expect(tui.captureFrame()).toContain("main draft");
  expect(tui.captureFrame()).not.toMatch(/› worker draft/);

  await tui.resize(40, 22);
  await tui.sendKey("pagedown", { ctrl: true });
  await tui.waitForText(/to recon web tier/);
  const compactRows = tui.rawFrame().replace(/਀/g, " ").split("\n");
  const moreY = compactRows.findIndex((row) => row.includes("more ·"));
  expect(moreY).toBeGreaterThanOrEqual(0);
  await tui.click(compactRows[moreY]!.indexOf("more"), moreY);
  await tui.waitForText(/to auth & session fuzzing/);
  await tui.sendKey("pagedown", { ctrl: true });
  // Keyboard cycling skips settled workers; their retained rows stay clickable.
  await tui.waitForText(/main draft/);
  await tui.sendKey("home", { ctrl: true, shift: true });
  await tui.waitForText(/main draft/);
});

test("complete task and progress suffixes wrap inside the real renderer without displacing the composer", async () => {
  const setup = await createTestRenderer({ width: 75, height: 18, screenMode: "alternate-screen" });
  const rendererRoot = setup.renderer.root as { remove: (child: unknown) => unknown };
  const originalRemove = rendererRoot.remove.bind(rendererRoot);
  rendererRoot.remove = (child) => {
    try { return originalRemove(child); }
    catch (error) {
      if (error instanceof Error && /renderable child/.test(error.message)) return undefined;
      throw error;
    }
  };
  const root = createRoot(setup.renderer);
  const agents: HerdSubagentMap = {
    worker: {
      agentId: "worker", name: "InternalWorkerAddress", parentScanId: "root",
      task: "# Goal\nReview all authorization checks across the invoice API and validate object ownership for cross-workspace access\n# Acceptance\nDo not display the entire structured assignment",
      status: "running", maxTurns: 4, lastSeen: 0, startedAt: Date.now() - 45_000, activity: [],
      note: "Inspecting owner-scoped invoice lookups and exercising negative paths with a second workspace principal",
    },
  };
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame().replace(/਀/g, " ");
  };
  try {
    root.render(React.createElement("box", { width: 75, height: 18, flexDirection: "column" },
      React.createElement("text", { height: 1, flexShrink: 0 }, "COMPOSER_DRAFT"),
      React.createElement(AgentWorkList, {
        agents, selectedAgentId: "worker", width: 75, height: 12, theme: getTheme("0"),
        interactive: true, runningGlyph: "⠋", onSelect: () => {},
      }),
      React.createElement("text", { height: 1, flexShrink: 0 }, "STATUS_BOUNDARY"),
    ));
    await expect.poll(frame).toContain("cross-workspace access");
    const rendered = await frame();
    expect(rendered).toContain("second workspace principal");
    expect(rendered).not.toContain("structured assignment");
    expect(rendered).not.toContain("InternalWorkerAddress");
    const rows = rendered.split("\n");
    const taskStart = rows.findIndex((row) => row.includes("Review all authorization"));
    const taskTail = rows.findIndex((row) => row.includes("cross-workspace access"));
    const progressStart = rows.findIndex((row) => row.includes("Inspecting owner-scoped"));
    const progressTail = rows.findIndex((row) => row.includes("second workspace principal"));
    expect(taskTail).toBeGreaterThan(taskStart);
    expect(progressStart).toBeGreaterThan(taskTail);
    expect(progressTail).toBeGreaterThan(progressStart);
    expect(rows.findIndex((row) => row.includes("COMPOSER_DRAFT"))).toBeLessThan(taskStart);
    expect(rows.findIndex((row) => row.includes("STATUS_BOUNDARY"))).toBeGreaterThan(progressTail);
    expect(rows[progressStart]).toMatch(/⠋\s+\d+s\s+Inspecting/);
  } finally {
    root.unmount();
    await settle();
    setup.renderer.destroy();
  }
});
