/** Input hardening for the Markdown renderer: caps and invisible-character stripping, applied before parsing. */
export const MARKDOWN_LIMITS = {
  chars: 400_000,
  /** Maximum block markers (>, list bullets) stacked at the start of one line. */
  lineNesting: 24,
  /** Longest run of one delimiter character before it is clamped. */
  delimiterRun: 32,
} as const;

// Bidi overrides/isolates and C0/C1 controls except tab and newline. ESC sequences are removed whole first.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Strip ANSI escapes, control characters and bidi overrides from text that will be shown to a person. */
export function stripUnsafeText(text: string): string {
  return text.replace(ANSI, "").replace(INVISIBLE, "").replace(/\r\n?/g, "\n");
}

export type PreparedMarkdown = { text: string; plain: boolean };

/**
 * Returns text safe to hand to the parser. Inputs that exceed the size or nesting
 * caps come back with `plain: true` and must be rendered as preformatted text.
 */
export function prepareMarkdown(input: string): PreparedMarkdown {
  const truncated = input.length > MARKDOWN_LIMITS.chars;
  const text = stripUnsafeText(truncated ? input.slice(0, MARKDOWN_LIMITS.chars) : input);
  if (truncated) return { text, plain: true };
  const marker = /^(?: {0,3}(?:>|[-*+]|\d{1,9}[.)])[ \t]?|[ \t]+)*/;
  let clamped = text;
  for (const line of text.split("\n")) {
    const prefix = marker.exec(line)?.[0] ?? "";
    // Count markers rather than characters so ordinary indentation is free.
    if ((prefix.match(/>|[-*+](?=[ \t])|\d[.)]/g)?.length ?? 0) > MARKDOWN_LIMITS.lineNesting) return { text, plain: true };
  }
  const run = MARKDOWN_LIMITS.delimiterRun;
  clamped = clamped.replace(/([*_~`=#|\-+])\1{32,}/g, (m, c: string) => c.repeat(run));
  // Interleaved delimiters ("*_*_*_...") evade single-character runs.
  if (/(?:[*_~][*_~]?){200,}/.test(clamped)) return { text: clamped, plain: true };
  return { text: clamped, plain: false };
}
