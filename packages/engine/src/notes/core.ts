// The one Memory: short plain notes 0 remembers across threads. Pure core: schema, text
// format and ids. Ranking and the prompt budget are in rank.ts, taint rules in taint.ts.
// No file or network access lives here.
import { createHash } from "node:crypto";
import { stripHidden } from "./guard.js";

export const NOTE_KINDS = ["fix-decision", "convention", "command", "avoid"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteScope = "folder" | "global";
/** user: typed by a person. model: written by 0 through the memory tool. import: arrived from an archive or an older store. */
export type NoteSource = "user" | "model" | "import";
/** proposed notes wait for review and are never shown to the model or the scan verifier. */
export type NoteStatus = "live" | "proposed";

export interface Note {
  id: string;
  text: string;
  scope: NoteScope;
  source: NoteSource;
  status: NoteStatus;
  created: string;
  /** Thread that wrote the note (model notes). */
  thread?: string;
  /** The writing thread had read untrusted content (web, files, MCP, extensions). */
  tainted?: boolean;
  /** A person accepted this note after it was proposed. */
  reviewed?: boolean;
  /** Last day the note was put in a prompt. Informational: ranking never uses it. */
  lastInjected?: string;
  /** Folder identity the note belongs to (folder scope only): `git:<host>/<path>` or an absolute path. */
  folder?: string;
  kind?: NoteKind;
}

export const MAX_NOTE_CHARS = 500;

/** One line of plain text: hidden characters are removed, newlines collapse, length is clamped. Empty text is rejected by callers. */
export function cleanText(input: string): string {
  const text = stripHidden(input).replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS - 1)}…` : text;
}

export function isKind(value: unknown): value is NoteKind {
  return typeof value === "string" && (NOTE_KINDS as readonly string[]).includes(value);
}

/** Stable id for a note, derived from scope and text so hand-written lines get the same id every read. */
export function noteId(text: string, scope: NoteScope, folder?: string, salt?: number | string): string {
  const base = `${scope}\0${folder ?? ""}\0${text.toLowerCase()}`;
  const payload = salt !== undefined ? `${base}\0${salt}` : base;
  return `m_${createHash("sha256").update(payload).digest("hex").slice(0, 8)}`;
}

export function folderKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

/** Accepts the older vocabulary (`you`, `0`) when reading files and archives. */
export function parseSource(value: unknown, fallback: NoteSource = "user"): NoteSource {
  return value === "user" || value === "you" ? "user" : value === "model" || value === "0" ? "model" : value === "import" ? "import" : fallback;
}

/** A person wrote it or accepted it: the only notes allowed to steer a scan verifier. */
export const isTrusted = (note: Note): boolean => note.status === "live" && (note.source === "user" || note.reviewed === true);

const META = /\s*<!--\s*(.*?)\s*-->\s*$/;
const token = (value: string): string => value.replace(/[^\w.:@/-]/g, "_").slice(0, 80);

/** `- text <!-- id=m_x kind=command source=user status=live created=ISO thread=t tainted=1 -->`; metadata is optional on hand-written lines. */
export function formatNote(note: Note): string {
  const meta = [`id=${note.id}`, note.kind ? `kind=${note.kind}` : "", `source=${note.source}`, note.status === "proposed" ? "status=proposed" : "", `created=${note.created}`,
    note.thread ? `thread=${token(note.thread)}` : "", note.tainted ? "tainted=1" : "", note.reviewed ? "reviewed=1" : "", note.lastInjected ? `injected=${note.lastInjected}` : ""];
  return `- ${note.text} <!-- ${meta.filter(Boolean).join(" ")} -->`;
}

export function parseNotes(markdown: string, scope: NoteScope, folder: string | undefined, fallbackCreated: string): Note[] {
  const notes: Note[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!item) continue;
    let body = item[1]!;
    const meta: Record<string, string> = {};
    const match = META.exec(body);
    if (match) {
      body = body.slice(0, match.index);
      for (const pair of match[1]!.split(/\s+/)) { const eq = pair.indexOf("="); if (eq > 0) meta[pair.slice(0, eq)] = pair.slice(eq + 1); }
    }
    const text = cleanText(body);
    if (!text) continue;
    const note: Note = { id: /^m_[a-z0-9]{4,}$/.test(meta["id"] ?? "") ? meta["id"]! : noteId(text, scope, folder), text, scope,
      source: parseSource(meta["source"]), status: meta["status"] === "proposed" ? "proposed" : "live", created: meta["created"] ?? fallbackCreated };
    if (isKind(meta["kind"])) note.kind = meta["kind"];
    if (meta["thread"]) note.thread = meta["thread"];
    if (meta["tainted"] === "1") note.tainted = true;
    if (meta["reviewed"] === "1") note.reviewed = true;
    const injected = meta["injected"] ?? meta["used"];
    if (injected) note.lastInjected = injected;
    if (folder) note.folder = folder;
    notes.push(note);
  }
  return notes;
}
