/** Line-editing transforms for the chat composer. */

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Backspace removes one visible character, never half an emoji or accent. */
export function deletePreviousCharacter(text: string): string {
  if (!text) return text;
  const last = GRAPHEMES.segment(text).containing(text.length - 1);
  return text.slice(0, last?.index ?? 0);
}

/** Move by one visible character without splitting a joined emoji or accent. */
export function stepComposerCursor(text: string, cursor: number, direction: -1 | 1): number {
  const at = Math.max(0, Math.min(text.length, cursor));
  if (direction < 0) {
    if (at === 0) return 0;
    return GRAPHEMES.segment(text).containing(at - 1)?.index ?? 0;
  }
  if (at === text.length) return at;
  const next = GRAPHEMES.segment(text).containing(at);
  return next ? next.index + next.segment.length : text.length;
}

/** Delete everything before the caret on the current logical line. */
export function deleteToLineStart(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}

/**
 * Delete the word before the caret, plus any whitespace between the caret
 * and that word — the readline/bash `unix-word-rubout` behaviour.
 *
 * `\S*\s*$` anchors at the end and the engine takes the leftmost match that
 * can reach it, which is precisely "the last run of whitespace, and the run
 * of non-whitespace immediately before it":
 *
 *   "foo bar"    → "foo "     (word only)
 *   "foo bar "   → "foo "     (trailing space AND the word it follows)
 *   "   "        → ""         (all whitespace collapses in one step)
 *   ""           → ""         (idempotent on empty)
 *
 * Both runs are matched as whole units, so a cut never lands inside a
 * surrogate pair: the boundaries are whitespace, and no whitespace character
 * is half of an astral code point.
 */
export function deletePreviousWord(text: string): string {
  return text.replace(/\S*\s*$/, "");
}
