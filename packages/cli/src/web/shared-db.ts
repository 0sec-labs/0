// One long-lived osecDB handle per database path for the web server's request handlers.
//
// Opening an osecDB runs `PRAGMA quick_check` (a full B-tree scan) plus a schema
// migration write transaction. Doing that per HTTP request cost 150-190 ms on a
// 42 MB database. The handle is opened lazily once, then reused; `close()` on
// the returned handle is a no-op so existing `try { ... } finally { db.close() }`
// call sites keep working.
//
// Locking: node-sqlite3-wasm only holds SQLite file locks while a statement is
// executing (the shim finalizes every statement), and all use here is
// synchronous, so a long-lived connection does not block other 0 processes and
// still sees their committed writes. WAL stays off (unsupported by the wasm VFS).
// The engine ownership guard lives in local-engine.ts and is unaffected.
import { statSync } from "node:fs";
import type { osecDB } from "@0/engine/storage";

interface Entry { db: osecDB; ino: number; dev: number; view: osecDB }

const MAX_HANDLES = 4;
const handles = new Map<string, Entry>();

function identity(path: string): { ino: number; dev: number } | undefined {
  if (path === ":memory:") return { ino: 0, dev: 0 };
  try { const stat = statSync(path); return { ino: stat.ino, dev: stat.dev }; } catch { return undefined; }
}

function disposeEntry(path: string): void {
  const entry = handles.get(path);
  if (!entry) return;
  handles.delete(path);
  try { entry.db.close(); } catch { /* Already closed or never fully opened. */ }
}

/** Drop (and close) the cached handle, e.g. before the database file is reset. */
export async function evictSharedDb(dbPath: string | undefined): Promise<void> {
  const { resolveOsecDbPath } = await import("@0/engine/storage");
  disposeEntry(resolveOsecDbPath(dbPath));
}

/** Close every cached handle (server shutdown, tests). */
export function closeSharedDbs(): void {
  for (const path of [...handles.keys()]) disposeEntry(path);
}

/** Open (once) and return a handle whose `close()` is a no-op. */
export async function openSharedDb(dbPath: string | undefined): Promise<osecDB> {
  const { osecDB: Database, resolveOsecDbPath } = await import("@0/engine/storage");
  const path = resolveOsecDbPath(dbPath);
  const entry = handles.get(path);
  if (entry) {
    const current = identity(path);
    // Replaced, deleted or reset underneath us: reopen instead of serving a stale inode.
    if (current && current.ino === entry.ino && current.dev === entry.dev) {
      handles.delete(path); handles.set(path, entry); // refresh LRU position
      return entry.view;
    }
    disposeEntry(path);
  }
  const db = new Database(path);
  const ids = identity(path) ?? { ino: 0, dev: 0 };
  const view = Object.create(db, { close: { value: () => undefined } }) as osecDB;
  handles.set(path, { db, ...ids, view });
  while (handles.size > MAX_HANDLES) disposeEntry(handles.keys().next().value as string);
  return view;
}
