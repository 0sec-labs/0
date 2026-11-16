/** Pure: pull text out of a tool response with hard bounds applied BEFORE anything is concatenated or scanned. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_RESPONSE_BLOCKS = 64;

export interface BoundedText { readonly text: string; readonly clipped: boolean }

/**
 * Only the `content` array is read: at most MAX_RESPONSE_BLOCKS blocks, at most MAX_RESPONSE_BYTES of text in total
 * (a block is cut, not scanned whole), and nested values are never walked, so response depth cannot cost time.
 */
export function boundedText(content: unknown, maxBytes = MAX_RESPONSE_BYTES, maxBlocks = MAX_RESPONSE_BLOCKS): BoundedText {
  if (typeof content === "string") return content.length > maxBytes ? { text: content.slice(0, maxBytes), clipped: true } : { text: content, clipped: false };
  if (!Array.isArray(content)) return { text: "", clipped: false };
  const parts: string[] = []; let used = 0; let clipped = content.length > maxBlocks;
  for (const block of content.slice(0, maxBlocks)) {
    if (used >= maxBytes) { clipped = true; break; }
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type; const text = (block as { text?: unknown }).text;
    if (type === "text" && typeof text === "string") {
      const room = maxBytes - used; const piece = text.length > room ? (clipped = true, text.slice(0, room)) : text;
      parts.push(piece); used += piece.length;
    } else if (typeof type === "string") parts.push(`[${type.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)} content omitted]`);
  }
  return { text: parts.join("\n"), clipped };
}
