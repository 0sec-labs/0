// HTTP face of the one Memory for the web page: list, add, edit, delete, turn off, export, import.
import { MemoryError, NOTE_KINDS, exportArchive, importArchive, isArchive, isKind, openMemory, type NoteStore } from "@0/engine";

type Reply = { status: number; data: unknown };
const BASE = "/api/console/memory";
const text = (value: unknown, max = 4000): string | undefined => (typeof value === "string" && value.length <= max ? value : undefined);
const body = (input: unknown): Record<string, unknown> => (input && typeof input === "object" ? input as Record<string, unknown> : {});

export function isMemoryPath(path: string): boolean { return path === BASE || path.startsWith(`${BASE}/`); }

export function handleMemoryRequest(path: string, method: string, input: unknown, query: URLSearchParams, open: () => NoteStore = () => openMemory()): Reply | null {
  if (!isMemoryPath(path)) return null;
  const store = open();
  const sub = path.slice(BASE.length).replace(/^\//, "");
  const data = body(input);
  try {
    if (sub === "" && method === "GET") {
      const folder = query.get("folder") || undefined;
      const all = store.list();
      return { status: 200, data: { enabled: store.enabled(), kinds: NOTE_KINDS, folders: [...new Set(all.flatMap(note => note.folder ? [note.folder] : []))].sort(),
        notes: store.list({ ...(folder ? { folder } : {}), ...(query.get("q") ? { query: query.get("q")! } : {}) }) } };
    }
    if (sub === "" && method === "POST") {
      const noteText = text(data["text"]);
      if (!noteText) return { status: 400, data: { error: "Write the note first." } };
      const scope = data["scope"] === "folder" ? "folder" : "global";
      const folder = text(data["folder"], 4096);
      if (scope === "folder" && !folder) return { status: 400, data: { error: "Choose a folder for this note." } };
      return { status: 200, data: { note: store.add({ text: noteText, scope, folder, kind: isKind(data["kind"]) ? data["kind"] : undefined, source: "you" }) } };
    }
    if (sub === "enabled" && method === "POST") { store.setEnabled(data["enabled"] !== false); return { status: 200, data: { enabled: store.enabled() } }; }
    if (sub === "clear" && method === "POST") return { status: 200, data: { removed: store.clear(text(data["folder"], 4096)) } };
    if (sub === "export" && method === "GET") return { status: 200, data: exportArchive(store, query.get("folder") || undefined) };
    if (sub === "import" && method === "POST") {
      const archive = data["archive"];
      if (!isArchive(archive)) return { status: 400, data: { error: "That file is not a 0 memory file." } };
      return { status: 200, data: importArchive(store, archive) };
    }
    const id = /^(m_[a-z0-9]+)$/.exec(sub)?.[1];
    if (id && method === "PATCH") {
      const note = store.edit(id, text(data["text"]) ?? "");
      return note ? { status: 200, data: { note } } : { status: 404, data: { error: "That note is gone." } };
    }
    if (id && method === "DELETE") return store.remove(id) ? { status: 200, data: { removed: id } } : { status: 404, data: { error: "That note is gone." } };
    return { status: 405, data: { error: "Unsupported memory operation." } };
  } catch (error) {
    if (error instanceof MemoryError) return { status: 400, data: { error: error.message } };
    throw error;
  }
}
