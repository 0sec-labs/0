import { describe, expect, it } from "vitest";

import type { ChatEntry } from "./types.js";
import {
  toolActionTitle,
  toolHeaderStatus,
  toolInputSection,
  toolRunningNote,
  toolState,
} from "./card-layout.js";

/** Minimal tool entry with the fields a test cares about layered on. */
function entry(partial: Partial<ChatEntry>): ChatEntry {
  return { id: "e1", kind: "tool", text: "run_command", turn: 1, ...partial } as ChatEntry;
}

describe("toolInputSection — no duplicate input section", () => {
  // The "command shown twice" bug: the command is the border TITLE, so an input
  // section repeating it is dead weight. command / edit / web all convey their
  // input in the header or the body, so none gets an input section.
  it("returns null for a command entry (the $ cmd headline already shows it)", () => {
    const e = entry({ metaKind: "command", command: "npm test -- --silent", commandOutput: "ok" });
    expect(toolInputSection(e)).toBeNull();
  });

  it("returns null for an edit entry (path in header, diff in body)", () => {
    const e = entry({ metaKind: "edit", text: "apply_patch", editPath: "src/a.ts", editDiff: "+x" });
    expect(toolInputSection(e)).toBeNull();
  });

  it("returns null for a web entry (query/answer/sources render in the body)", () => {
    const e = entry({ metaKind: "web", text: "web_search", webQuery: "cve 2024" });
    expect(toolInputSection(e)).toBeNull();
  });

  it("keeps an Arguments section for a generic tool (its only input display)", () => {
    const e = entry({ text: "read_file", toolArgs: "src/a.ts @120" });
    const input = toolInputSection(e);
    expect(input).not.toBeNull();
    expect(input?.label).toBe("Arguments");
    expect(input?.lines).toContain("src/a.ts @120");
  });

  it("returns null for a generic tool that retained no arguments", () => {
    expect(toolInputSection(entry({ text: "read_file" }))).toBeNull();
  });
});

describe("command card renders the command exactly once", () => {
  it("the command appears in the title and NOT in any input section", () => {
    const command = "npm test -- --silent";
    const e = entry({ metaKind: "command", command, commandOutput: "3 passing", exitCode: 0, success: true });
    const title = toolActionTitle(e);
    // Title carries it once …
    expect(title).toBe(`$ ${command}`);
    // … and there is no second copy in an input section.
    expect(toolInputSection(e)).toBeNull();
  });
});

describe("toolHeaderStatus — compact, no multi-row State/Exit/Ceiling block", () => {
  it("a clean completed command adds nothing (state is on the border)", () => {
    const e = entry({ metaKind: "command", command: "ls", exitCode: 0, success: true, wallMs: 20 });
    expect(toolHeaderStatus(e, toolState(e))).toBe("");
  });

  it("a non-zero exit folds onto the header as `· exit N`", () => {
    const e = entry({ metaKind: "command", command: "false", exitCode: 2, success: false, wallMs: 5 });
    expect(toolHeaderStatus(e, toolState(e))).toBe(" · exit 2");
  });

  it("a wallclock kill reads `· timed out`", () => {
    const e = entry({ metaKind: "command", command: "sleep 99", timedOut: true, success: false });
    expect(toolHeaderStatus(e, toolState(e))).toContain("timed out");
  });

  it("a generic failure with no exit/timeout still says so once", () => {
    const e = entry({ text: "read_file", success: false });
    expect(toolHeaderStatus(e, toolState(e))).toBe(" · failed");
  });

  it("an edit folds its `+A -R` delta onto the header", () => {
    const e = entry({ metaKind: "edit", text: "apply_patch", editAdded: 5, editRemoved: 2, success: true });
    expect(toolHeaderStatus(e, toolState(e))).toBe(" · +5 -2");
  });

  it("a web search folds its source count onto the header", () => {
    const e = entry({
      metaKind: "web",
      text: "web_search",
      webSources: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }],
      success: true,
    });
    expect(toolHeaderStatus(e, toolState(e))).toBe(" · 3 sources");
  });

  it("ceiling never appears in the header after completion", () => {
    const e = entry({ metaKind: "command", command: "ls", exitCode: 0, success: true, timeoutMs: 30_000 });
    expect(toolHeaderStatus(e, toolState(e))).not.toContain("ceiling");
  });
});

describe("toolRunningNote — ceiling shows only while running", () => {
  it("a running call shows the ceiling budget", () => {
    const e = entry({ metaKind: "command", command: "sleep 5", timeoutMs: 30_000 });
    expect(toolState(e)).toBe("running");
    expect(toolRunningNote(e, toolState(e), "◌")).toBe("◌ running · ceiling 30s");
  });

  it("a running call with no ceiling shows a bare running note", () => {
    const e = entry({ metaKind: "command", command: "sleep 5" });
    expect(toolRunningNote(e, toolState(e), "◌")).toBe("◌ running");
  });

  it("a settled call shows no running note (ceiling drops away)", () => {
    const e = entry({ metaKind: "command", command: "ls", exitCode: 0, success: true, timeoutMs: 30_000 });
    expect(toolRunningNote(e, toolState(e), "◌")).toBeUndefined();
  });
});
