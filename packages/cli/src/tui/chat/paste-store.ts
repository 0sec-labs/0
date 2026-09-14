/**
 * OMP-style paste collapsing for the composer.
 *
 * A large paste — long text, or a path to an image file — is a nuisance when it
 * lands raw in the composer: it buries the operator's own words and makes the
 * input scroll away. Instead we stash the full payload here and drop a compact
 * CHIP marker into the buffer (`[Pasted text #1 · 42 lines]`, `[Image #2]`).
 * The composer stays a plain string, so wrapping, history and the slash menu are
 * untouched; the marker is just literal text. At the Enter boundary the caller
 * runs {@link expandPasteMarkers} to swap each marker back for its full payload
 * before the message ships, then clears the ids it consumed.
 *
 * Pure and dependency-free so it is trivially unit-tested; the screen owns the
 * store instance and the monotonic counter.
 */

/** A paste is "long" (worth collapsing) at or past either threshold. */
export const PASTE_MIN_LINES = 8;
export const PASTE_MIN_CHARS = 800;

/** A pasted single line ending in one of these extensions is treated as an image path. */
export const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

export type PasteEntry =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string };

export type PasteStore = Map<string, PasteEntry>;

export function createPasteStore(): PasteStore {
  return new Map<string, PasteEntry>();
}

/**
 * True when a paste is large enough to collapse: eight or more lines, OR 800 or
 * more characters. Either dimension trips it, so a single very long line
 * (no newlines) still collapses.
 */
export function isLongPaste(text: string): boolean {
  return countLines(text) >= PASTE_MIN_LINES || text.length >= PASTE_MIN_CHARS;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

/**
 * The chip label for a stored text paste. Multi-line pastes are described by
 * their line count; a single long line has no meaningful line count, so it is
 * described by its character count instead.
 */
function describeText(text: string): string {
  const lines = countLines(text);
  return lines > 1 ? `${lines} lines` : `${text.length} chars`;
}

function textMarker(id: string, text: string): string {
  return `[Pasted text #${id} · ${describeText(text)}]`;
}

function imageMarker(id: string): string {
  return `[Image #${id}]`;
}

/** Matches a text chip and captures its id. Body is opaque — only the id matters. */
const TEXT_MARKER_RE = /\[Pasted text #(\d+) · [^\]]*\]/g;
/** Matches an image chip and captures its id. */
const IMAGE_MARKER_RE = /\[Image #(\d+)\]/g;

/**
 * Stash a long text paste and return the chip marker to insert plus its store
 * id. `counter` is the chip number N (the caller keeps a monotonic ref); it
 * doubles as the store key, so text and image chips share one number space and
 * never collide.
 */
export function addText(store: PasteStore, counter: number, text: string): { marker: string; id: string } {
  const id = String(counter);
  store.set(id, { kind: "text", text });
  return { marker: textMarker(id, text), id };
}

/** Stash an image path and return its chip marker plus store id. See {@link addText}. */
export function addImage(store: PasteStore, counter: number, path: string): { marker: string; id: string } {
  const id = String(counter);
  store.set(id, { kind: "image", path });
  return { marker: imageMarker(id), id };
}

/**
 * Expand every chip marker in `input` back to its stored payload.
 *
 * - A text chip becomes the stored full text.
 * - An image chip becomes a plain-text REFERENCE the agent can act on with its
 *   file tools (`Image at <path>`) — NOT a multimodal block; there is no vision
 *   plumbing yet.
 * - A marker whose id is missing from the store (e.g. one the operator typed by
 *   hand) is left verbatim — a no-op.
 *
 * Returns the expanded text and the ids that were actually consumed, so the
 * caller can clear exactly those store entries after the message ships.
 */
export function expandPasteMarkers(input: string, store: PasteStore): { text: string; consumedIds: string[] } {
  const consumed = new Set<string>();
  let out = input.replace(TEXT_MARKER_RE, (marker, id: string) => {
    const entry = store.get(id);
    if (entry?.kind === "text") {
      consumed.add(id);
      return entry.text;
    }
    return marker;
  });
  out = out.replace(IMAGE_MARKER_RE, (marker, id: string) => {
    const entry = store.get(id);
    if (entry?.kind === "image") {
      consumed.add(id);
      return `Image at ${entry.path}`;
    }
    return marker;
  });
  return { text: out, consumedIds: [...consumed] };
}
