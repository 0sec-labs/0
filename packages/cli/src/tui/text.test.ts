import { describe, expect, it } from "vitest";
import { fitHint, fitLegend, fitTuiText, fitTuiUrl, keyGlyph, keyLegend, sanitizeComposerText, sanitizeTuiText } from "./text.js";

describe("sanitizeComposerText", () => {
  it("preserves whitespace exactly (trailing, leading, and runs)", () => {
    // The composer caret must be able to sit after a just-typed space — so
    // unlike sanitizeTuiText this must NOT collapse runs or trim the ends.
    expect(sanitizeComposerText("the ")).toBe("the ");
    expect(sanitizeComposerText("a  b")).toBe("a  b");
    expect(sanitizeComposerText("  x")).toBe("  x");
    expect(sanitizeComposerText("")).toBe("");
  });

  it("still strips terminal control sequences (paste safety)", () => {
    expect(sanitizeComposerText("\x1b[31mred\x1b[0m more")).toBe("red more");
  });
});

describe("sanitizeTuiText", () => {
  it("collapses whitespace and strips terminal control sequences", () => {
    expect(sanitizeTuiText("\x1b[31mred\x1b[0m\n\tvalue")).toBe("red value");
  });

  it("replaces large encoded payloads before rendering", () => {
    const encoded = "A".repeat(180);
    expect(sanitizeTuiText(`token=${encoded}`)).toBe("token=[encoded payload omitted]");
  });

  it("falls back to the default encoded-run limit for non-finite options", () => {
    const encoded = "A".repeat(180);
    expect(sanitizeTuiText(`token=${encoded}`, { maxEncodedRun: Number.NaN })).toBe("token=[encoded payload omitted]");
    expect(sanitizeTuiText(`token=${encoded}`, { maxEncodedRun: Number.POSITIVE_INFINITY })).toBe("token=[encoded payload omitted]");
  });

  it("normalizes fractional encoded-run limits before building the regexp", () => {
    const encoded = "A".repeat(33);
    expect(sanitizeTuiText(`token=${encoded}`, { maxEncodedRun: 32.9 })).toBe("token=[encoded payload omitted]");
  });

  it("clamps absurdly large encoded-run limits to the safe upper bound", () => {
    const encoded = "A".repeat(1_500_000);
    expect(sanitizeTuiText(`token=${encoded}`, { maxEncodedRun: 1e+300 })).toBe("token=[encoded payload omitted]");
  });

  it("falls back to the cap for unsafe-integer-range values that would stringify to scientific notation", () => {
    const encoded = "A".repeat(1_500_000);
    // 1e+21 would stringify with scientific notation and break regexp construction
    // without the clamp; the cap normalizes it to a decimal-digit quantifier.
    expect(sanitizeTuiText(`token=${encoded}`, { maxEncodedRun: 1e+21 })).toBe("token=[encoded payload omitted]");
  });
});

describe("fitTuiText", () => {
  it("returns short text unchanged", () => {
    expect(fitTuiText("short", 12)).toBe("short");
  });

  it("clips long text at the end with a stable max width", () => {
    const out = fitTuiText("abcdefghijklmnopqrstuvwxyz", 10);
    expect(out).toBe("abcdefg...");
    expect(out.length).toBe(10);
  });

  it("handles very small widths without overflowing", () => {
    expect(fitTuiText("abcdef", 2)).toBe("..");
  });
});

describe("fitTuiUrl", () => {
  it("preserves both ends of long paths and URLs", () => {
    const out = fitTuiUrl("https://example.com/a/very/long/path/with/query?token=secret", 24);
    expect(out).toBe("https://exa...ken=secret");
    expect(out.length).toBe(24);
  });
});

describe("fitHint", () => {
  it("picks the widest authored variant whose width fits", () => {
    const variants = [
      "Ctrl+Alt: ↑↓ select · N new · W close · * unread", // 48
      "↑↓ select · N new · W close", // 27
      "↑↓ · N new · W close", // 20
    ];
    expect(fitHint(60, variants)).toBe(variants[0]);
    expect(fitHint(30, variants)).toBe(variants[1]);
    expect(fitHint(24, variants)).toBe(variants[2]);
  });

  it("never emits a mid-word ellipsis while any whole variant fits", () => {
    const out = fitHint(30, [
      "Ctrl+Alt: ↑↓ select · N new · W close · * unread",
      "↑↓ select · N new · W close",
      "↑↓ · N new · W close",
    ]);
    expect(out.endsWith("...")).toBe(false);
  });

  it("falls back to the shortest variant, truncated only as a last resort", () => {
    // Even the shortest variant is wider than the pane: last-resort ellipsis.
    expect(fitHint(6, ["longer one", "shortish"])).toBe("sho...");
  });

  it("ignores variant order and empty variants", () => {
    expect(fitHint(10, ["", "abc", "abcdefghijkl"])).toBe("abc");
    expect(fitHint(10, [])).toBe("");
  });
});

describe("fitLegend", () => {
  it("drops whole trailing ' · ' units instead of clipping a word", () => {
    const legend = "↑↓ move · / filter · esc back · ctrl+c exit";
    // Wide enough for everything.
    expect(fitLegend(80, legend)).toBe(legend);
    // Not wide enough for the last two units — drop them whole, no ellipsis.
    const narrowed = fitLegend(20, legend);
    expect(narrowed.endsWith("...")).toBe(false);
    expect(narrowed).toBe("↑↓ move · / filter");
  });

  it("accepts an explicit variant list (widest that fits)", () => {
    expect(fitLegend(12, ["one · two · three", "one · two", "one"])).toBe("one · two");
  });

  it("behaves like fitTuiText for a single-unit hint", () => {
    expect(fitLegend(12, "no separators here")).toBe(fitTuiText("no separators here", 12));
  });
});

describe("keyGlyph / keyLegend", () => {
  it("maps named keys to their display glyphs", () => {
    expect(keyGlyph("updown")).toBe("↑↓");
    expect(keyGlyph("enter")).toBe("⏎");
    expect(keyGlyph("esc")).toBe("esc");
    expect(keyGlyph("tab")).toBe("⇥");
  });

  it("renders control chords with modifier glyphs and an upper-cased letter", () => {
    expect(keyGlyph("ctrl+c")).toBe("⌃C");
    expect(keyGlyph("shift+tab")).toBe("⇧⇥");
    expect(keyGlyph("ctrl+u")).toBe("⌃U");
  });

  it("passes single-character and unknown tokens through verbatim", () => {
    expect(keyGlyph("/")).toBe("/");
    expect(keyGlyph("r")).toBe("r");
    expect(keyGlyph("*")).toBe("*");
  });

  it("builds a bracketed legend joined by the standard separator", () => {
    expect(
      keyLegend([
        { keys: "updown", label: "move" },
        { keys: "enter", label: "confirm" },
        { keys: "/", label: "filter" },
        { keys: "esc" },
      ]),
    ).toBe("[↑↓] move · [⏎] confirm · [/] filter · [esc]");
  });

  it("produces legends fitLegend can shrink by dropping trailing units", () => {
    const legend = keyLegend([
      { keys: "updown", label: "move" },
      { keys: "/", label: "filter" },
      { keys: "esc", label: "back" },
    ]);
    expect(fitLegend(80, legend)).toBe(legend);
    expect(fitLegend(14, legend)).toBe("[↑↓] move");
  });
});
