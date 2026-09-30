/**
 * A terminal transcript cannot hand arbitrarily large model text to a rich
 * renderer: Markdown turns one source string into many native text buffers.
 * Keep the canonical message intact and make a bounded, head-and-tail display
 * projection for the TUI only.
 */
export const MAX_TRANSCRIPT_PREVIEW_CHARS = 8_000;

/** Rich Markdown across visible transcript entries is capped separately. */
export const MAX_RICH_TRANSCRIPT_CHARS = 24_000;

function marker(omitted: number): string {
  return `\n\n… [${omitted} characters hidden in this TUI preview; copy the message for full text] …\n\n`;
}

// Reserve the longest possible JavaScript string-length marker so the result
// remains inside the requested limit even when the omitted count is large.
const MAX_MARKER_CHARS = marker(Number.MAX_SAFE_INTEGER).length;

function headBoundary(text: string, end: number): number {
  const bounded = Math.max(0, Math.min(text.length, end));
  if (
    bounded > 0
    && bounded < text.length
    && text.charCodeAt(bounded - 1) >= 0xd800
    && text.charCodeAt(bounded - 1) <= 0xdbff
    && text.charCodeAt(bounded) >= 0xdc00
    && text.charCodeAt(bounded) <= 0xdfff
  ) return bounded - 1;
  return bounded;
}

function tailBoundary(text: string, start: number): number {
  const bounded = Math.max(0, Math.min(text.length, start));
  if (
    bounded > 0
    && bounded < text.length
    && text.charCodeAt(bounded - 1) >= 0xd800
    && text.charCodeAt(bounded - 1) <= 0xdbff
    && text.charCodeAt(bounded) >= 0xdc00
    && text.charCodeAt(bounded) <= 0xdfff
  ) return bounded + 1;
  return bounded;
}

export interface TranscriptPreview {
  text: string;
  omittedChars: number;
}

/** Return the complete source when it fits, otherwise a bounded head/tail view. */
export function previewTranscriptText(
  source: string,
  maxChars = MAX_TRANSCRIPT_PREVIEW_CHARS,
): TranscriptPreview {
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : MAX_TRANSCRIPT_PREVIEW_CHARS;
  if (source.length <= limit) return { text: source, omittedChars: 0 };
  if (limit <= MAX_MARKER_CHARS) return { text: "…", omittedChars: source.length - 1 };

  const visible = limit - MAX_MARKER_CHARS;
  const headEnd = headBoundary(source, Math.ceil(visible / 2));
  const tailStart = tailBoundary(source, source.length - Math.floor(visible / 2));
  const head = source.slice(0, headEnd);
  const tail = source.slice(tailStart);
  const omittedChars = source.length - head.length - tail.length;
  return { text: `${head}${marker(omittedChars)}${tail}`, omittedChars };
}
