import { describe, expect, it } from "vitest";
import { createTranscriptDocument } from "@0/shared";
import {
  MAX_REVIEW_CHARS,
  boundTranscriptReviewContent,
  compileTranscriptReview,
} from "./transcript-review.js";
import type { ChatEntry } from "./chat/types.js";

function entry(overrides: Partial<ChatEntry> & Pick<ChatEntry, "id" | "kind" | "text">): ChatEntry {
  return { turn: 1, ...overrides };
}

describe("compileTranscriptReview", () => {
  it("compiles markdown messages into semantic plain-text review lines", () => {
    const document = compileTranscriptReview(createTranscriptDocument([
      entry({ id: "user", kind: "user", text: "check **this**" }),
      entry({ id: "assistant", kind: "assistant", text: "# Result\n\n**verified**" }),
    ]), { width: 60, detail: "expanded" });

    expect(document.text).toContain("OPERATOR");
    expect(document.text).toContain("check this");
    expect(document.text).toContain("ZERO");
    expect(document.text).toContain("# Result");
    expect(document.text).toContain("verified");
  });

  it("uses the existing folded transcript plan for collapsed detail", () => {
    const document = compileTranscriptReview(createTranscriptDocument([
      entry({ id: "tool", kind: "tool", text: "read_file", detail: "src/index.ts", turn: 4, success: true }),
      entry({ id: "reasoning", kind: "reasoning", text: "thinking", turn: 4 }),
    ]), { width: 60, detail: "collapsed" });

    expect(document.lines).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^▸ /), tone: "fold", turn: 4 }),
    ]);
  });

  it("retains rich tool output in expanded review mode", () => {
    const document = compileTranscriptReview(createTranscriptDocument([
      entry({
        id: "command",
        kind: "tool",
        text: "run_command",
        toolArgs: "pnpm test",
        commandOutput: "line one\nline two",
        detail: "2 lines",
        success: true,
      }),
    ]), { width: 60, detail: "expanded" });

    expect(document.text).toContain("TOOL done · run_command · pnpm test");
    expect(document.text).toContain("line one");
    expect(document.text).toContain("line two");
  });

  it("sanitizes terminal control sequences in non-markdown detail", () => {
    const document = compileTranscriptReview(createTranscriptDocument([
      entry({ id: "error", kind: "error", text: "failed", detail: "\u001b[31munsafe\u001b[0m" }),
    ]), { width: 60, detail: "expanded" });

    expect(document.text).toContain("unsafe");
    expect(document.text).not.toContain("\u001b");
  });

  it("keeps the review projection bounded for long conversations", () => {
    const document = compileTranscriptReview(createTranscriptDocument(
      Array.from({ length: 12 }, (_, index) => entry({
        id: `assistant-${index}`,
        kind: "assistant",
        text: `START ${index} ${"review content alpha beta ".repeat(450)} END ${index}`,
        turn: index + 1,
      })),
    ), { width: 80, detail: "expanded" });

    expect(document.text.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS);
    expect(document.text).toContain("earlier review lines hidden");
    expect(document.text).toContain("END 11");
  });

  it("bounds a huge final non-message row before creating the native review buffer", () => {
    const document = compileTranscriptReview(createTranscriptDocument([
      entry({
        id: "final-error",
        kind: "error",
        text: `START ${"terminal failure detail ".repeat(10_000)} END`,
      }),
    ]), { width: 80, detail: "expanded" });

    expect(document.text.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS);
    expect(document.text).toContain("hidden in this TUI preview");
    expect(document.text).toContain("START");
    expect(document.text).toContain("END");
  });

  it("caps composed review chrome and recap text at the native-buffer boundary", () => {
    const document = compileTranscriptReview(createTranscriptDocument(
      Array.from({ length: 10 }, (_, index) => entry({
        id: `assistant-${index}`,
        kind: "assistant",
        text: `BODY ${index} ${"content ".repeat(1_000)} END ${index}`,
        turn: index + 1,
      })),
    ), { width: 80, detail: "expanded" });
    const content = boundTranscriptReviewContent(
      `RECAP START ${"recap ".repeat(4_000)} RECAP END\n${document.text}`,
    );

    expect(content.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS);
    expect(content).toContain("RECAP START");
    expect(content).toContain("END 9");
    expect(content).toContain("hidden in this TUI preview");
  });
});
