// Pure helpers for the Memory page: types, labels and filtering. No React, no network.
export const NOTE_KIND_LABELS = { "fix-decision": "Fix decision", convention: "Convention", command: "Command", avoid: "Avoid" } as const;
export type NoteKind = keyof typeof NOTE_KIND_LABELS;
export interface MemoryNote {
  id: string; text: string; scope: "folder" | "global"; source: "user" | "model" | "import"; created: string;
  thread?: string; lastInjected?: string; folder?: string; kind?: NoteKind;
}
/** Notes a folder's threads (or, with no folder, any thread) would not be shown because the prompt budget is full. */
export interface MemoryOverflow { folder?: string; count: number; ids: string[]; reason?: string }
export interface MemoryResponse { enabled: boolean; notes: MemoryNote[]; overflow: MemoryOverflow[]; folders: string[]; kinds: NoteKind[] }

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

/** "Everywhere" for global notes, the folder name otherwise, then the kind. */
export function noteDetail(note: MemoryNote): string {
  return [note.scope === "global" ? "Everywhere" : folderLabel(note.folder ?? "folder"), note.kind ? NOTE_KIND_LABELS[note.kind] : ""].filter(Boolean).join(" · ");
}

/** `all` shows everything, `global` only global notes, any other value is a folder path. */
export function filterNotes(notes: readonly MemoryNote[], filter: string, search: string): MemoryNote[] {
  const q = search.trim().toLowerCase();
  return notes.filter(note => (filter === "all" || (filter === "global" ? note.scope === "global" : note.folder === filter)) && (!q || note.text.toLowerCase().includes(q)));
}

/** The sentence for notes the model is not shown, for the selected filter; empty when everything fits. */
export function overflowNotice(overflow: readonly MemoryOverflow[], filter: string): string {
  const relevant = overflow.filter(entry => filter === "all" || (filter === "global" ? entry.folder === undefined : entry.folder === filter || entry.folder === undefined));
  const ids = new Set(relevant.flatMap(entry => entry.ids));
  if (!ids.size) return "";
  return `${ids.size} older note${ids.size === 1 ? "" : "s"} over the limit, not used.`;
}
