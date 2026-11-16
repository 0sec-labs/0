// Pure helpers for the Memory page: types, labels and filtering. No React, no network.
export const NOTE_KIND_LABELS = { "fix-decision": "Fix decision", convention: "Convention", command: "Command", avoid: "Avoid" } as const;
export type NoteKind = keyof typeof NOTE_KIND_LABELS;
export interface MemoryNote {
  id: string; text: string; scope: "folder" | "global"; source: "user" | "model" | "import"; status: "live" | "proposed"; created: string;
  thread?: string; tainted?: boolean; reviewed?: boolean; lastInjected?: string; folder?: string; kind?: NoteKind;
}
/** Notes a folder's threads (or, with no folder, any thread) would not be shown because the prompt budget is full. */
export interface MemoryOverflow { folder?: string; count: number; ids: string[]; reason?: string }
export interface MemoryResponse { enabled: boolean; notes: MemoryNote[]; proposed: MemoryNote[]; overflow: MemoryOverflow[]; folders: string[]; kinds: NoteKind[] }

/**
 * How a note's folder reads in a list. A repository (`git:host/owner/name`) is shown as `owner/name`; a path is shown whole with its
 * leading slash, and the home directory collapsed to `~` (`home` when known, else the usual `/Users/x`, `/home/x` and `/root`).
 */
export function folderLabel(folder: string, home?: string): string {
  if (folder.startsWith("git:")) return folder.slice(4).split("/").filter(Boolean).slice(1).join("/") || folder;
  const root = home?.replace(/\/+$/, "");
  if (root && (folder === root || folder.startsWith(`${root}/`))) return `~${folder.slice(root.length)}`;
  return folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)|^\/root(?=\/|$)/, "~");
}

const WRITERS = { user: "You", model: "Suggested by a thread", import: "Imported" } as const;

/** "Everywhere" for global notes, the folder name otherwise, then the kind and who wrote it. */
export function noteDetail(note: MemoryNote): string {
  return [note.scope === "global" ? "Everywhere" : folderLabel(note.folder ?? "folder"), note.kind ? NOTE_KIND_LABELS[note.kind] : "", WRITERS[note.source]].filter(Boolean).join(" · ");
}

/** `all` shows everything, `global` only global notes, any other value is a folder path. */
export function filterNotes(notes: readonly MemoryNote[], filter: string, search: string): MemoryNote[] {
  const q = search.trim().toLowerCase();
  return notes.filter(note => (filter === "all" || (filter === "global" ? note.scope === "global" : note.folder === filter)) && (!q || note.text.toLowerCase().includes(q)));
}

/** Why a note is in Proposed: its thread had read content that is not the person's own. */
export const TAINT_REASON = "This thread read web pages or other outside content before suggesting this note.";

/** Where a proposal came from, in plain words: it read outside content, or it did not. */
export function proposalDetail(note: MemoryNote): string {
  return [noteDetail(note), note.tainted ? TAINT_REASON : ""].filter(Boolean).join(" · ");
}

/** The sentence for notes the model is not shown, for the selected filter; empty when everything fits. */
export function overflowNotice(overflow: readonly MemoryOverflow[], filter: string): string {
  const relevant = overflow.filter(entry => filter === "all" || (filter === "global" ? entry.folder === undefined : entry.folder === filter || entry.folder === undefined));
  const ids = new Set(relevant.flatMap(entry => entry.ids));
  if (!ids.size) return "";
  return `${ids.size} note${ids.size === 1 ? " is" : "s are"} not shown to the model: ${relevant.find(entry => entry.reason)?.reason ?? "the memory budget is full"}. Forget or shorten some notes to bring them back.`;
}
