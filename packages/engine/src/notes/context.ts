// What a thread does with Memory: read the notes at the start of each turn, and the one tool
// the model has (remember, forget). Nothing here writes a note unless the model calls the tool.
import { MEMORY_HEADER, isKind, renderPrompt, selectForPrompt, type Note, type NoteKind } from "./core.js";
import { canonicalFolder, createFileNoteStore, type NoteStore } from "./store.js";

export const MEMORY_DISABLED_ENV = ["ZERO_DISABLE_MEMORY", "ZERO_DISABLE_HUNT_MEMORY"] as const;
export const memoryDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean => MEMORY_DISABLED_ENV.some(name => /^(1|true)$/i.test(env[name] ?? ""));

export interface MemoryContext { notes: Note[]; text: string }

/** The notes for one thread, ranked and clamped to the budget, already rendered as untrusted context. Marks them used. */
export function memoryContext(store: NoteStore, folder?: string, budgetTokens?: number): MemoryContext {
  if (!store.enabled()) return { notes: [], text: "" };
  const folderKey = folder ? canonicalFolder(folder) : undefined;
  const notes = selectForPrompt(store.list(), { ...(folderKey ? { folder: folderKey } : {}), ...(budgetTokens ? { budgetTokens } : {}) });
  if (notes.length) store.markUsed(notes.map(note => note.id));
  return { notes, text: renderPrompt(notes) };
}

export interface MemoryToolArgs { action: "remember" | "forget"; note?: string; kind?: string; scope?: "folder" | "global"; id?: string }
export interface MemoryToolResult { id?: string; removed?: boolean; message: string }

/** `remember` saves one note the model chose to keep; `forget` removes one by id. Folder is the thread's folder, when it has one. */
export function runMemoryTool(store: NoteStore, folder: string | undefined, args: MemoryToolArgs): MemoryToolResult {
  if (!store.enabled()) throw new Error("Memory is off.");
  if (args.action === "forget") {
    if (!args.id) throw new Error("forget needs the id of a note.");
    const removed = store.remove(args.id);
    return { removed, message: removed ? `Forgot ${args.id}.` : `No note ${args.id}.` };
  }
  if (!args.note?.trim()) throw new Error("remember needs a note.");
  const kind: NoteKind | undefined = isKind(args.kind) ? args.kind : undefined;
  const scope = args.scope === "global" || !folder ? "global" : "folder";
  const note = store.add({ text: args.note, scope, ...(scope === "folder" ? { folder } : {}), ...(kind ? { kind } : {}), source: "0" });
  return { id: note.id, message: `Remembered ${note.id}.` };
}

export { MEMORY_HEADER };

/** Notes tagged "avoid" (known false positives, rejected approaches) as untrusted context for a verification prompt. Never decides a verdict. */
export function verifyContext(store: NoteStore, folder?: string, budgetTokens = 600): string {
  if (!store.enabled()) return "";
  const folderKey = folder ? canonicalFolder(folder) : undefined;
  const notes = selectForPrompt(store.list().filter(note => note.kind === "avoid"), { ...(folderKey ? { folder: folderKey } : {}), budgetTokens });
  if (!notes.length) return "";
  return `${MEMORY_HEADER.split(" Add a lasting")[0]} Earlier decisions to avoid repeating, such as known false positives; current evidence still decides.\n${notes.map(note => `- ${note.text}`).join("\n")}`;
}

/** The scan pipelines' one call: open Memory (unless vetoed) and render its avoid notes. Memory trouble never fails a scan. */
export function scanVerifyContext(folder?: string): string {
  if (memoryDisabledByEnv()) return "";
  try { return verifyContext(createFileNoteStore(), folder); } catch { return ""; }
}
