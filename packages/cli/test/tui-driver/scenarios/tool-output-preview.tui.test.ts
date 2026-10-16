import { setImmediate as settle } from "node:timers/promises";
import React, { useState } from "react";
import { expect, test } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { renderEntry } from "../../../src/tui/chat/TranscriptEntry.js";
import type { ChatEntry, EntryDisplay } from "../../../src/tui/chat/types.js";
import { getTheme } from "../../../src/tui/themes.js";

const output = Array.from({ length: 80 }, (_, index) => `output-line-${String(index + 1).padStart(3, "0")}`).join("\n");
const entries: ChatEntry[] = [
  { id: "command", kind: "tool", text: "bash", turn: 1, success: true, metaKind: "command", command: "printf many-lines", commandOutput: output,
    toolPreview: { kind: "code", language: "bash", lines: output.split("\n"), truncated: false } },
  { id: "code", kind: "tool", text: "js_eval", turn: 1, success: true, metaKind: "code", codeLanguage: "javascript", codeSource: "console.log('many lines')", codeOutput: output },
  { id: "task", kind: "tool", text: "spawn_agents", turn: 1, success: true, metaKind: "task", taskLabel: "Review output",
    toolPreview: { kind: "code", language: "json", lines: output.split("\n"), truncated: false } },
];

test.each(entries)("$id previews stay bounded despite an expanded preference, and explicit disclosure retains the tail", async (entry) => {
  const setup = await createTestRenderer({ width: 110, height: 110, screenMode: "alternate-screen" });
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
  const theme = getTheme("0");
  const display: EntryDisplay = {
    spacing: 0, showTimestamps: false, now: 0, transcriptStyle: "plain", roleLabelStyle: "off",
    toolCardStyle: "rail", richToolCards: true, mode: "Standard", modeColor: theme.MUTED,
    model: "fixture", modelInFooter: false, showTokenUsage: false, showCost: false,
    transcriptDetail: "expanded",
  };
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  let disclose: () => void = () => {};
  function Harness() {
    const [expanded, setExpanded] = useState<boolean | undefined>();
    disclose = () => setExpanded((previous) => previous !== true);
    return renderEntry(entry, 110, display, theme, { expanded, onToggle: disclose });
  }
  try {
    root.render(React.createElement(Harness));
    await expect.poll(frame).toContain("output-line-001");
    const preview = await frame();
    const visible = preview.match(/output-line-\d{3}/g) ?? [];
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(20);
    expect(preview).not.toContain("output-line-021");
    expect(preview).toContain("more lines");

    disclose();
    await expect.poll(frame).toContain("output-line-080");

    disclose();
    await expect.poll(frame).not.toContain("output-line-080");
    expect((await frame()).match(/output-line-\d{3}/g)?.length).toBeLessThanOrEqual(20);
  } finally {
    root.unmount();
    await settle();
    setup.renderer.destroy();
  }
});
