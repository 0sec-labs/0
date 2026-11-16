export * from "./core.js";
export * from "./store.js";
export * from "./migrate.js";

import { createFileNoteStore, type FileStoreOptions, type NoteStore } from "./store.js";
import { migrateOldMemory, type MigrationOptions } from "./migrate.js";

/** The one way callers open Memory: the file store, with the one-time import of older stores done first. Never throws on import trouble. */
export function openMemory(options: FileStoreOptions & Pick<MigrationOptions, "dbPath" | "craftPaths"> = {}): NoteStore {
  const store = createFileNoteStore(options);
  try { migrateOldMemory(store, options); } catch { /* an unreadable old store must not block the new Memory */ }
  return store;
}
export * from "./archive.js";
export * from "./context.js";
