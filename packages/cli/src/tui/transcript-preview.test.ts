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
    // Adjacent limits force opposite UTF-16 parity at the head/tail cuts.
    for (const limit of [200, 201]) {
      const preview = previewTranscriptText("😀".repeat(1_000), limit);
      expect(preview.text.length).toBeLessThanOrEqual(limit);
      expect(preview.text).toMatch(/^😀/);
      expect(preview.text).toMatch(/😀$/);
      expect(preview.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    }
  });
});
