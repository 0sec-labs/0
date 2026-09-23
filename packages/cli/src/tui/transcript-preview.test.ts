import { describe, expect, it } from "vitest";

import {
  MAX_TRANSCRIPT_PREVIEW_CHARS,
  previewTranscriptText,
} from "./transcript-preview.js";

describe("previewTranscriptText", () => {
  it("keeps short text unchanged", () => {
    expect(previewTranscriptText("short")).toEqual({ text: "short", omittedChars: 0 });
  });

  it("bounds long text while retaining both its beginning and tail", () => {
    const preview = previewTranscriptText(`START ${"x".repeat(20_000)} END`);
    expect(preview.text.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_PREVIEW_CHARS);
    expect(preview.text).toMatch(/^START/);
    expect(preview.text).toMatch(/END$/);
    expect(preview.text).toContain("hidden in this TUI preview");
    expect(preview.omittedChars).toBeGreaterThan(0);
  });

  it("does not split an emoji surrogate pair at either preview boundary", () => {
    const preview = previewTranscriptText(`a`.repeat(4_000) + "😀" + "b".repeat(4_000) + "😀END");
    expect(preview.text).not.toContain("\ufffd");
    expect(preview.text).toContain("😀END");
  });
});
