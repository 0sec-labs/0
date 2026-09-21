/**
 * Shared helpers for TUI scenarios. Not a `*.tui.test.ts`, so it is not
 * collected as a test file — only imported.
 */

import type { LaunchOptions, TuiHandle } from "../index.js";

/**
 * Launch options that pin the model picker onto a STABLE, deterministic BYOK
 * catalogue for keyboard/mouse navigation tests.
 *
 * Left to itself the picker's runtime resolves asynchronously to the hosted
 * lane, which — offline (see env.ts) — loads an empty "0 models" catalogue with
 * nothing to navigate, and the BYOK→hosted flip makes any assertion racy.
 * Pinning a BYOK provider + model via env keeps the picker on the curated BYOK
 * list (a fixed 66-model catalogue) that is present from the first paint and
 * does not flip. `mouseSupport` is opt-in per scenario: it defaults off in the
 * deterministic env (mouse chrome is noisy), but a hover test must turn it on
 * so the renderer arms its hit grid (see `modelsByokLaunch`).
 */
export function modelsByokLaunch(opts: { mouse?: boolean } = {}): LaunchOptions {
  return {
    route: { type: "models" },
    settings: opts.mouse ? { mouseSupport: true } : {},
    env: {
      DEEPSEEK_API_KEY: "test-key",
      "ZERO_PROVIDER": "deepseek",
      "ZERO_MODEL": "deepseek-chat",
    },
  };
}

/**
 * The list row the picker is currently highlighting, read from the captured
 * per-cell spans.
 *
 * The active row is the only list line painted with the PRIMARY highlight
 * BACKGROUND (see dialog-select.tsx: `bg = isActive ? theme.PRIMARY`), so it is
 * found without knowing any exact colour: take the most common background as the
 * page ground, then pick the line carrying the widest run of a DIFFERENT
 * background. Full-width chrome bars (the title/status/composer rows) and the
 * empty left rail are excluded by width so only a real, partial-width list row
 * with text wins. Returns the line index and its trimmed text (`{ index: -1 }`
 * when nothing is highlighted).
 */
export function highlightedRow(
  frame: ReturnType<TuiHandle["captureSpans"]>,
): { index: number; text: string } {
  const bgKey = (bg: { toInts: () => number[] }): string => bg.toInts().join(",");

  // Page ground = the background covering the most cells.
  const widthByBg = new Map<string, number>();
  for (const line of frame.lines) {
    for (const span of line.spans) {
      const key = bgKey(span.bg);
      widthByBg.set(key, (widthByBg.get(key) ?? 0) + span.width);
    }
  }
  let pageBg = "";
  let widest = -1;
  for (const [key, width] of widthByBg) {
    if (width > widest) {
      widest = width;
      pageBg = key;
    }
  }

  let index = -1;
  let bestWidth = 0;
  let text = "";
  frame.lines.forEach((line, i) => {
    let width = 0;
    let lineText = "";
    for (const span of line.spans) {
      if (bgKey(span.bg) !== pageBg) {
        width += span.width;
        lineText += span.text;
      }
    }
    const trimmed = lineText.trim();
    // A highlighted list row: a partial-width coloured run that carries text.
    // Exclude the full-width chrome bars (>= cols-5) and the blank gutter cells.
    if (trimmed.length > 0 && width > 10 && width < frame.cols - 5 && width > bestWidth) {
      bestWidth = width;
      index = i;
      text = trimmed;
    }
  });
  return { index, text };
}

/** The model id from a highlighted list row's text (drops the `●` current dot and price). */
export function modelLabel(rowText: string): string {
  return (rowText.replace(/^●\s*/, "").split(/\s{2,}|\$/)[0] ?? "").trim();
}

/**
 * The home screen is fully interactive once the composer prompt is up. Offline
 * the hosted cloud is deliberately unreachable (see env.ts), so the status line
 * settles on "Cloud: Unavailable"; either marker means the screen is ready to
 * drive.
 */
export const HOME_READY = /type to chat or \/ for commands|Cloud: (Unavailable|Loading)/;

/** Any box-drawing glyph: light/heavy/double borders, corners, tees and dividers. */
export const BORDER_GLYPHS =
  /[─-╿]/; // Unicode "Box Drawing" block (│ ─ ╭ ╮ ╰ ╯ ┌ ┐ … ═ ║).

/** The framebuffer's blank-cell fill glyph, replaced with a space for readable slices. */
const FILL = /਀/g;

/** Split a captured frame into lines with the fill glyph normalized to spaces. */
export function frameLines(frame: string): string[] {
  return frame.replace(FILL, " ").split("\n");
}

/**
 * The inclusive slice of lines between the first line matching `from` and the
 * first later line matching `to`. Throws a helpful error (with the frame) if
 * either marker is missing, so a scenario fails loudly rather than on an empty
 * slice.
 */
export function regionBetween(frame: string, from: RegExp, to: RegExp): string[] {
  const lines = frameLines(frame);
  const start = lines.findIndex((l) => from.test(l));
  if (start === -1) throw new Error(`region start ${from} not found in frame:\n${lines.join("\n")}`);
  const end = lines.findIndex((l, i) => i > start && to.test(l));
  if (end === -1) throw new Error(`region end ${to} not found in frame:\n${lines.join("\n")}`);
  return lines.slice(start, end + 1);
}
