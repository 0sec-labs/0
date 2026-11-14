/**
 * Prefill bus: "put this text in the composer". Callers (setup cards, plugin pages, suggestion chips) cannot know which
 * mission the composer will land on (Home reuses a blank mission with a real id), so they queue the text here and the
 * mounted composer workspace applies it to whichever draft it owns. The pending text survives a reload via sessionStorage.
 */
import { STORAGE_KEYS, storage, type StorageApi } from "./storage";

export const COMPOSER_PREFILL_EVENT = "0:composer-prefill";

let pending: string | null = null;

/** Draft text after prefilling: typed text is never overwritten, the prefill goes on a new line. */
export function mergePrefill(current: string, text: string): string {
  if (!text) return current;
  if (!current.trim()) return text;
  if (current.includes(text)) return current;
  return current.endsWith("\n") ? current + text : `${current}\n${text}`;
}

export function queueComposerPrefill(text: string, api: Pick<StorageApi, "writeText"> = storage): void {
  if (!text.trim()) return;
  pending = pending && !pending.includes(text) ? `${pending}\n${text}` : pending ?? text;
  api.writeText(STORAGE_KEYS.composerPrefill, pending, "session");
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COMPOSER_PREFILL_EVENT));
}

/** Take the pending text (memory first, then storage after a reload) and clear it. */
export function consumeComposerPrefill(api: Pick<StorageApi, "readText" | "remove"> = storage): string | null {
  const text = pending ?? api.readText(STORAGE_KEYS.composerPrefill, "session");
  pending = null;
  api.remove(STORAGE_KEYS.composerPrefill, "session");
  return text && text.trim() ? text : null;
}

export function resetComposerPrefillForTest(): void { pending = null; }
