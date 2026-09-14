import { describe, expect, it } from "vitest";

import {
  PASTE_MIN_CHARS,
  PASTE_MIN_LINES,
  addImage,
  addText,
  createPasteStore,
  expandPasteMarkers,
  isLongPaste,
} from "./paste-store.js";

describe("isLongPaste", () => {
  it("collapses at the line threshold and not below it", () => {
    const eightLines = Array.from({ length: PASTE_MIN_LINES }, (_, i) => `line ${i}`).join("\n");
    const sevenLines = Array.from({ length: PASTE_MIN_LINES - 1 }, (_, i) => `line ${i}`).join("\n");
    expect(isLongPaste(eightLines)).toBe(true);
    expect(isLongPaste(sevenLines)).toBe(false);
  });

  it("collapses at the char threshold even on a single line", () => {
    expect(isLongPaste("x".repeat(PASTE_MIN_CHARS))).toBe(true);
    expect(isLongPaste("x".repeat(PASTE_MIN_CHARS - 1))).toBe(false);
  });

  it("leaves a short, few-line paste inline", () => {
    expect(isLongPaste("just a line\nand another")).toBe(false);
  });
});

describe("addText", () => {
  it("describes a multi-line paste by its line count and stores the full text", () => {
    const store = createPasteStore();
    const text = "a\nb\nc";
    const { marker, id } = addText(store, 1, text);
    expect(marker).toBe("[Pasted text #1 · 3 lines]");
    expect(id).toBe("1");
    expect(store.get("1")).toEqual({ kind: "text", text });
  });

  it("describes a single long line by its char count", () => {
    const store = createPasteStore();
    const text = "x".repeat(900);
    const { marker } = addText(store, 4, text);
    expect(marker).toBe("[Pasted text #4 · 900 chars]");
  });
});

describe("addImage", () => {
  it("emits an image chip and stores the path", () => {
    const store = createPasteStore();
    const { marker, id } = addImage(store, 2, "/tmp/shot.png");
    expect(marker).toBe("[Image #2]");
    expect(id).toBe("2");
    expect(store.get("2")).toEqual({ kind: "image", path: "/tmp/shot.png" });
  });
});

describe("expandPasteMarkers", () => {
  it("round-trips text and reports the consumed id", () => {
    const store = createPasteStore();
    const text = "line one\nline two\nline three";
    const { marker } = addText(store, 1, text);
    const input = `look at this: ${marker} thanks`;
    const { text: out, consumedIds } = expandPasteMarkers(input, store);
    expect(out).toBe(`look at this: ${text} thanks`);
    expect(consumedIds).toEqual(["1"]);
  });

  it("emits a file-path reference for an image chip, not a multimodal block", () => {
    const store = createPasteStore();
    const { marker } = addImage(store, 3, "/tmp/pic.jpg");
    const { text: out, consumedIds } = expandPasteMarkers(`see ${marker}`, store);
    expect(out).toBe("see Image at /tmp/pic.jpg");
    expect(consumedIds).toEqual(["3"]);
  });

  it("expands multiple mixed chips in one pass", () => {
    const store = createPasteStore();
    const a = addText(store, 1, "big\ntext\nhere\nnow\nok");
    const b = addImage(store, 2, "/tmp/a.png");
    const { text: out, consumedIds } = expandPasteMarkers(`${a.marker} and ${b.marker}`, store);
    expect(out).toBe("big\ntext\nhere\nnow\nok and Image at /tmp/a.png");
    expect(consumedIds.sort()).toEqual(["1", "2"]);
  });

  it("no-ops on a missing key, leaving the marker verbatim", () => {
    const store = createPasteStore();
    const input = "hi [Pasted text #99 · 5 lines] and [Image #7]";
    const { text: out, consumedIds } = expandPasteMarkers(input, store);
    expect(out).toBe(input);
    expect(consumedIds).toEqual([]);
  });

  it("leaves a literal user-typed marker untouched when no entry backs it", () => {
    const store = createPasteStore();
    addText(store, 1, "real paste content");
    // The user literally typed a marker-shaped string for a different id.
    const input = "I mean the [Pasted text #2 · 3 lines] snippet";
    const { text: out, consumedIds } = expandPasteMarkers(input, store);
    expect(out).toBe(input);
    expect(consumedIds).toEqual([]);
  });

  it("returns the input unchanged when there are no markers", () => {
    const store = createPasteStore();
    const { text: out, consumedIds } = expandPasteMarkers("plain message", store);
    expect(out).toBe("plain message");
    expect(consumedIds).toEqual([]);
  });
});
