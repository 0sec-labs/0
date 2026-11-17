// NoteStore port and its file adapter: one MEMORY.md per scope under <home>/.0/memory/.
// Global notes: memory/MEMORY.md. Folder notes: memory/<key>/MEMORY.md where the key hashes the
// folder identity (git origin, else real path; see identity.ts), so nothing is written into a
// repository and a repository cannot supply notes of its own. Older folders keyed by plain path
// are still read: both lookups stay, and each note's folder is resolved to its identity on read.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../shared/index.js";
import { cleanText, folderKey, formatNote, isKind, noteId, parseNotes, type Note, type NoteKind, type NoteScope, type NoteSource, type NoteStatus } from "./core.js";
import { screenText } from "./guard.js";
import { folderIdentity } from "./identity.js";

export interface NoteInput {
  text: string; scope?: NoteScope; folder?: string; kind?: NoteKind; source?: NoteSource; created?: string;
  status?: NoteStatus; thread?: string; tainted?: boolean; reviewed?: boolean;
}
export interface NoteFilter { folder?: string; scope?: NoteScope; query?: string; /** Default: live notes only. */ status?: NoteStatus | "all" }
export interface EditOptions { /** Who is changing it. A model edit drops the user/accepted trust the note had. */ by?: NoteSource; thread?: string; tainted?: boolean }

export interface NoteStore {
  list(filter?: NoteFilter): Note[];
  add(input: NoteInput): Note;
  edit(id: string, text: string, options?: EditOptions): Note | undefined;
  /** Turn a proposal into a live, reviewed note, optionally with corrected text. */
  accept(id: string, text?: string): Note | undefined;
  remove(id: string): boolean;
  /** Remove every note, or the notes of one folder. Returns how many were removed. */
  clear(folder?: string): number;
  /** Record that notes were put in a prompt. Lazy: a file is rewritten at most once per note per day. */
  markInjected(ids: readonly string[], at?: string): void;
  /** Notes the model has written (live or proposed) on the given UTC day, for the daily limit. */
  modelWritesOn(day: string): number;
  enabled(): boolean;
  setEnabled(on: boolean): void;
}

/** Stable folder identity (see identity.ts). */
export const canonicalFolder = folderIdentity;

export class MemoryError extends Error {}

export interface FileStoreOptions { home?: string; now?: () => Date }

export function memoryDir(home?: string): string { return join(homeStateDir(home), "memory"); }

interface Entry { note: Note; file: string; header?: string }
const injectedSeen = new Map<string, string>();

export function createFileNoteStore(options: FileStoreOptions = {}): NoteStore {
  const dir = memoryDir(options.home);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const globalFile = join(dir, "MEMORY.md");
  const folderHeader = /^<!--\s*folder:\s*(.*?)\s*-->/m;

  function readFile(file: string, scope: NoteScope, header?: string): Note[] {
    if (!existsSync(file)) return [];
    try { return parseNotes(readFileSync(file, "utf8"), scope, header ? folderIdentity(header) : undefined, statSync(file).mtime.toISOString()); } catch { return []; }
  }
  function writeNotes(file: string, notes: readonly Note[], header?: string): void {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const head = header ? `<!-- folder: ${header} -->\n# Memory for ${header}\n\n` : "# Memory\n\n";
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${head}${notes.map(formatNote).join("\n")}${notes.length ? "\n" : ""}`, { mode: 0o600 });
    renameSync(tmp, file);
  }
  function folderFiles(): Array<{ file: string; header: string }> {
    if (!existsSync(dir)) return [];
    const found: Array<{ file: string; header: string }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "MEMORY.md");
      if (!existsSync(file)) continue;
      const header = folderHeader.exec(readFileSync(file, "utf8").slice(0, 2000))?.[1];
      if (header) found.push({ file, header });
    }
    return found;
  }
  const entries = (): Entry[] => [
    ...readFile(globalFile, "global").map(note => ({ note, file: globalFile })),
    ...folderFiles().flatMap(({ file, header }) => readFile(file, "folder", header).map(note => ({ note, file, header }))),
  ];
  const all = (): Note[] => entries().map(entry => entry.note);
  /** Rewrite the file of one note in place (legacy folder files keep their own header). */
  const rewriteOf = (entry: Entry, change: (notes: Note[]) => Note[]) => writeNotes(entry.file, change(readFile(entry.file, entry.note.scope, entry.header)), entry.header);
  const find = (id: string): Entry | undefined => entries().find(entry => entry.note.id === id);
  const folderFileFor = (identity: string) => join(dir, folderKey(identity), "MEMORY.md");

  function screened(text: string): string {
    const result = screenText(text);
    if (!result.ok) throw new MemoryError(result.message);
    const clean = cleanText(result.text);
    if (!clean) throw new MemoryError("A note cannot be empty.");
    return clean;
  }

  return {
    list(filter = {}) {
      const query = filter.query?.toLowerCase();
      const folderFilter = filter.folder ? folderIdentity(filter.folder) : undefined;
      const status = filter.status ?? "live";
      const seen = new Set<string>();
      return all().filter(note => (status === "all" || note.status === status) && (!filter.scope || note.scope === filter.scope) && (!folderFilter || note.folder === folderFilter)
        && (!query || note.text.toLowerCase().includes(query)) && !seen.has(note.id) && !!seen.add(note.id))
        .sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
    },
    add(input) {
      const text = screened(input.text);
      const scope: NoteScope = input.scope ?? (input.folder ? "folder" : "global");
      if (scope === "folder" && !input.folder) throw new MemoryError("A folder note needs a folder.");
      const folder = scope === "folder" ? folderIdentity(input.folder!) : undefined;
      if (input.kind !== undefined && !isKind(input.kind)) throw new MemoryError("Unknown note kind.");
      const currentEntries = entries();
      const existing = currentEntries.find(entry =>
        entry.note.scope === scope &&
        entry.note.folder === folder &&
        entry.note.text.toLowerCase() === text.toLowerCase()
      );
      const status = input.status ?? "live";
      if (existing) {
        if (existing.note.status !== "proposed" || status !== "live") return existing.note;
        const promoted: Note = { ...existing.note, status: "live", reviewed: true };
        rewriteOf(existing, notes => notes.map(entry => entry.id === existing.note.id ? promoted : entry));
        return promoted;
      }
      const occupied = new Set(currentEntries.map(entry => entry.note.id));
      let id = noteId(text, scope, folder);
      let salt = 1;
      while (occupied.has(id)) {
        id = noteId(text, scope, folder, salt);
        salt++;
      }
      const note: Note = { id, text, scope, source: input.source ?? "user", status, created: input.created ?? now(),
        ...(folder ? { folder } : {}), ...(input.kind ? { kind: input.kind } : {}), ...(input.thread ? { thread: input.thread } : {}),
        ...(input.tainted ? { tainted: true } : {}), ...(input.reviewed ? { reviewed: true } : {}) };
      const file = scope === "global" ? globalFile : folderFileFor(folder!);
      writeNotes(file, [...readFile(file, scope, folder), note], folder);
      return note;
    },
    edit(id, text, edit = {}) {
      const clean = screened(text);
      const target = find(id);
      if (!target) return undefined;
      const edited: Note = { ...target.note, text: clean };
      if (edit.by === "model") {
        edited.source = "model"; delete edited.reviewed;
        if (edit.thread) edited.thread = edit.thread;
        if (edit.tainted) edited.tainted = true;
      }
      rewriteOf(target, notes => notes.map(note => note.id === id ? edited : note));
      return edited;
    },
    accept(id, text) {
      const target = find(id);
      if (!target || target.note.status !== "proposed") return undefined;
      const accepted: Note = { ...target.note, status: "live", reviewed: true, ...(text !== undefined ? { text: screened(text) } : {}) };
      rewriteOf(target, notes => notes.map(note => note.id === id ? accepted : note));
      return accepted;
    },
    remove(id) {
      const target = find(id);
      if (!target) return false;
      rewriteOf(target, notes => notes.filter(note => note.id !== id));
      return true;
    },
    clear(folder) {
      const identity = folder ? folderIdentity(folder) : undefined;
      const count = all().filter(note => !identity || note.folder === identity).length;
      if (!identity) { rmSync(globalFile, { force: true }); for (const { file } of folderFiles()) rmSync(file, { force: true }); }
      else for (const { file, header } of folderFiles()) if (folderIdentity(header) === identity) rmSync(file, { force: true });
      return count;
    },
    markInjected(ids, at = now()) {
      const day = at.slice(0, 10);
      const pending = ids.filter(id => injectedSeen.get(`${dir}\0${id}`) !== day);
      if (!pending.length) return;
      for (const id of pending) injectedSeen.set(`${dir}\0${id}`, day);
      const wanted = new Set(pending);
      const files = new Map<string, Entry>();
      for (const entry of entries()) if (wanted.has(entry.note.id) && entry.note.lastInjected !== day) files.set(entry.file, entry);
      for (const entry of files.values()) rewriteOf(entry, notes => notes.map(note => wanted.has(note.id) && note.lastInjected !== day ? { ...note, lastInjected: day } : note));
    },
    modelWritesOn: day => all().filter(note => note.source === "model" && note.created.startsWith(day)).length,
    enabled: () => !existsSync(join(dir, ".disabled")),
    setEnabled(on) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (on) rmSync(join(dir, ".disabled"), { force: true }); else writeFileSync(join(dir, ".disabled"), "", { mode: 0o600 });
    },
  };
}
