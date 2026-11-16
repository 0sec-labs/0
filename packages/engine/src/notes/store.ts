// MemoryStore port and its file adapter: one MEMORY.md per scope under <home>/.0/memory/.
// Global notes: memory/MEMORY.md. Folder notes: memory/<folder-hash>/MEMORY.md, so nothing is
// written into a repository and a repository cannot supply notes of its own.
import { existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homeStateDir } from "../shared/index.js";
import { cleanText, folderKey, formatNote, isKind, noteId, parseNotes, type Note, type NoteKind, type NoteScope, type NoteSource } from "./core.js";

export interface NoteInput { text: string; scope?: NoteScope; folder?: string; kind?: NoteKind; source?: NoteSource; created?: string }
export interface NoteFilter { folder?: string; scope?: NoteScope; query?: string }

export interface MemoryStore {
  list(filter?: NoteFilter): Note[];
  add(input: NoteInput): Note;
  edit(id: string, text: string): Note | undefined;
  remove(id: string): boolean;
  /** Remove every note, or the notes of one folder. Returns how many were removed. */
  clear(folder?: string): number;
  markUsed(ids: readonly string[], at?: string): void;
  enabled(): boolean;
  setEnabled(on: boolean): void;
}

/** Stable folder identity: absolute and symlink-resolved when the folder exists. */
export function canonicalFolder(folder: string): string {
  const abs = resolve(folder);
  try { return realpathSync(abs); } catch { return abs; }
}

export class MemoryError extends Error {}

export interface FileStoreOptions { home?: string; now?: () => Date }

export function memoryDir(home?: string): string { return join(homeStateDir(home), "memory"); }

export function createFileMemoryStore(options: FileStoreOptions = {}): MemoryStore {
  const dir = memoryDir(options.home);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const globalFile = join(dir, "MEMORY.md");
  const folderFile = (folder: string) => join(dir, folderKey(folder), "MEMORY.md");
  const folderHeader = /^<!--\s*folder:\s*(.*?)\s*-->/m;

  function readFile(file: string, scope: NoteScope, folder?: string): Note[] {
    if (!existsSync(file)) return [];
    try { return parseNotes(readFileSync(file, "utf8"), scope, folder, statSync(file).mtime.toISOString()); } catch { return []; }
  }
  function writeNotes(file: string, notes: readonly Note[], folder?: string): void {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const head = folder ? `<!-- folder: ${folder} -->\n# Memory for ${folder}\n\n` : "# Memory\n\n";
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${head}${notes.map(formatNote).join("\n")}${notes.length ? "\n" : ""}`, { mode: 0o600 });
    renameSync(tmp, file);
  }
  function folderFiles(): Array<{ file: string; folder: string }> {
    if (!existsSync(dir)) return [];
    const found: Array<{ file: string; folder: string }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "MEMORY.md");
      if (!existsSync(file)) continue;
      const folder = folderHeader.exec(readFileSync(file, "utf8").slice(0, 2000))?.[1];
      if (folder) found.push({ file, folder });
    }
    return found;
  }
  const all = (): Note[] => [...readFile(globalFile, "global"), ...folderFiles().flatMap(({ file, folder }) => readFile(file, "folder", folder))];
  const locate = (note: Pick<Note, "scope" | "folder">) => note.scope === "global" ? { file: globalFile, folder: undefined } : { file: folderFile(note.folder!), folder: note.folder };
  const rewrite = (scope: Pick<Note, "scope" | "folder">, change: (notes: Note[]) => Note[]) => {
    const { file, folder } = locate(scope);
    writeNotes(file, change(readFile(file, scope.scope, folder)), folder);
  };

  return {
    list(filter = {}) {
      const query = filter.query?.toLowerCase();
      const folderFilter = filter.folder ? canonicalFolder(filter.folder) : undefined;
      return all().filter(note => (!filter.scope || note.scope === filter.scope) && (!folderFilter || note.folder === folderFilter)
        && (!query || note.text.toLowerCase().includes(query)))
        .sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
    },
    add(input) {
      const text = cleanText(input.text);
      if (!text) throw new MemoryError("A note cannot be empty.");
      const scope: NoteScope = input.scope ?? (input.folder ? "folder" : "global");
      if (scope === "folder" && !input.folder) throw new MemoryError("A folder note needs a folder.");
      const folder = scope === "folder" ? canonicalFolder(input.folder!) : undefined;
      if (input.kind !== undefined && !isKind(input.kind)) throw new MemoryError("Unknown note kind.");
      const id = noteId(text, scope, folder);
      const note: Note = { id, text, scope, source: input.source ?? "you", created: input.created ?? now(), ...(folder ? { folder } : {}), ...(input.kind ? { kind: input.kind } : {}) };
      let result = note;
      rewrite(note, notes => { const existing = notes.find(entry => entry.id === id); if (existing) { result = existing; return notes; } return [...notes, note]; });
      return result;
    },
    edit(id, text) {
      const clean = cleanText(text);
      if (!clean) throw new MemoryError("A note cannot be empty.");
      const target = all().find(note => note.id === id);
      if (!target) return undefined;
      const edited: Note = { ...target, text: clean };
      rewrite(target, notes => notes.map(note => note.id === id ? edited : note));
      return edited;
    },
    remove(id) {
      const target = all().find(note => note.id === id);
      if (!target) return false;
      rewrite(target, notes => notes.filter(note => note.id !== id));
      return true;
    },
    clear(folder) {
      folder = folder ? canonicalFolder(folder) : undefined;
      const count = all().filter(note => !folder || note.folder === folder).length;
      if (!folder) { rmSync(globalFile, { force: true }); for (const { file } of folderFiles()) rmSync(file, { force: true }); }
      else rmSync(folderFile(folder), { force: true });
      return count;
    },
    markUsed(ids, at = now()) {
      if (!ids.length) return;
      const wanted = new Set(ids);
      for (const target of [{ scope: "global" as const, folder: undefined }, ...folderFiles().map(f => ({ scope: "folder" as const, folder: f.folder }))]) {
        const { file, folder } = locate(target);
        const notes = readFile(file, target.scope, folder);
        if (!notes.some(note => wanted.has(note.id))) continue;
        writeNotes(file, notes.map(note => wanted.has(note.id) ? { ...note, lastUsed: at } : note), folder);
      }
    },
    enabled: () => !existsSync(join(dir, ".disabled")),
    setEnabled(on) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (on) rmSync(join(dir, ".disabled"), { force: true }); else writeFileSync(join(dir, ".disabled"), "", { mode: 0o600 });
    },
  };
}
