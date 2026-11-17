// Portable export/import of notes, shared by the CLI and the web API. Reads the older
// version 1 archive (lessons with a `summary`) too. Imported notes are always source "import", live, and not reviewed: a file cannot vouch for itself.
import { isKind, type Note } from "./core.js";
import { canonicalFolder, type NoteStore } from "./store.js";

export const ARCHIVE_FORMAT = "zero-memory";
export interface NoteArchive { format: typeof ARCHIVE_FORMAT; version: 2; exportedAt: string; notes: Note[] }

export function exportArchive(store: NoteStore, folder?: string, now: Date = new Date()): NoteArchive {
  return { format: ARCHIVE_FORMAT, version: 2, exportedAt: now.toISOString(), notes: store.list(folder ? { folder } : {}) };
}

export function isArchive(value: unknown): value is { format: string; notes?: unknown; knowledge?: unknown } {
  return !!value && typeof value === "object" && (value as { format?: unknown }).format === ARCHIVE_FORMAT;
}

export function importArchive(store: NoteStore, archive: { notes?: unknown; knowledge?: unknown }): { added: number; total: number } {
  const items = (Array.isArray(archive.notes) ? archive.notes : Array.isArray(archive.knowledge) ? archive.knowledge : []).slice(0, 5000) as Array<Record<string, unknown>>;
  let added = 0;
  for (const item of items) {
    const text = typeof item?.["text"] === "string" ? item["text"] : typeof item?.["summary"] === "string" ? item["summary"] : "";
    if (!text.trim()) continue;
    const folder = item["scope"] === "folder" && typeof item["folder"] === "string" ? canonicalFolder(item["folder"]) : undefined;
    const before = store.list().length;
    store.add({ text, scope: folder ? "folder" : "global", folder, kind: isKind(item["kind"]) ? item["kind"] : undefined, source: "import",
      ...(typeof item["created"] === "string" ? { created: item["created"] } : {}) });
    if (store.list().length > before) added++;
  }
  return { added, total: items.length };
}
