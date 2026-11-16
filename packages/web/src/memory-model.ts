// Pure helpers for the Memory page: types, labels and filtering. No React, no network.
export const NOTE_KIND_LABELS = { "fix-decision": "Fix decision", convention: "Convention", command: "Command", avoid: "Avoid" } as const;
export type NoteKind = keyof typeof NOTE_KIND_LABELS;
export interface MemoryNote { id: string; text: string; scope: "folder" | "global"; source: "you" | "0"; created: string; lastUsed?: string; folder?: string; kind?: NoteKind }
export interface MemoryResponse { enabled: boolean; notes: MemoryNote[]; folders: string[]; kinds: NoteKind[] }

/** The last two path segments, enough to tell folders apart in a list. */
export function folderLabel(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || folder;
}

/** "Everywhere" for global notes, the folder name otherwise, then the kind and who wrote it. */
export function noteDetail(note: MemoryNote): string {
  return [note.scope === "global" ? "Everywhere" : folderLabel(note.folder ?? "folder"), note.kind ? NOTE_KIND_LABELS[note.kind] : "", note.source === "you" ? "You" : "0"].filter(Boolean).join(" · ");
}

/** `all` shows everything, `global` only global notes, any other value is a folder path. */
export function filterNotes(notes: readonly MemoryNote[], filter: string, search: string): MemoryNote[] {
  const q = search.trim().toLowerCase();
  return notes.filter(note => (filter === "all" || (filter === "global" ? note.scope === "global" : note.folder === filter)) && (!q || note.text.toLowerCase().includes(q)));
}
