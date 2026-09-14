/**
 * Shared helpers for TUI scenarios. Not a `*.tui.test.ts`, so it is not
 * collected as a test file — only imported.
 */

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
