/**
 * fish-shell / Claude-Code-style inline autosuggestion for the composer.
 *
 * As the operator types, the composer offers a dimmed continuation drawn from
 * what they have already submitted this session — pressing Right at the end of
 * the input accepts it. This module owns the one pure decision behind that
 * effect: given the current input and the submitted-message history, what is
 * the suffix (if any) to show as ghost text?
 *
 * The rule is fish's, verbatim: the suggestion is the MOST RECENT previously
 * submitted message that begins with the current input (case-sensitive prefix
 * over the whole line, not per word), with the current input stripped off so
 * only the remaining tail is returned. A candidate equal to the input adds
 * nothing and is skipped; a candidate shorter than, or not prefixed by, the
 * input cannot match. An empty input never suggests.
 *
 * Rendering, width-truncation and the keyboard wiring live in the composer;
 * this stays a total pure function so the prefix arithmetic is unit-tested here
 * rather than reasoned about inside a React component.
 */

/**
 * The ghost-text suffix to display after `input`, or `null` when there is
 * nothing to suggest.
 *
 * `history` is oldest-first (the same ring `composer-history.ts` maintains), so
 * the scan runs newest→oldest and returns the first entry that strictly extends
 * `input` as a prefix. Returns `null` for empty input, no match, an input that
 * already equals a full entry, or a candidate no longer than the input.
 */
export function suggestCompletion(
  input: string,
  history: readonly string[],
): string | null {
  if (input.length === 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    // Strictly longer AND prefixed: equal entries add nothing, shorter ones
    // cannot be a continuation, and a non-prefix never matches.
    if (entry.length > input.length && entry.startsWith(input)) {
      return entry.slice(input.length);
    }
  }
  return null;
}
