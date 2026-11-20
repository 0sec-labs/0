// What a thread does with Memory: read the live notes at the start of each turn, and the one
// tool the model has (remember, update, forget). Nothing here writes a note unless the model
// calls the tool, and what it may write depends on what the thread has read (taint.ts).
import { isKind, isTrusted, type Note, type NoteKind } from "./core.js";
import { screenText } from "./guard.js";
import { MEMORY_HEADER, fitToBudget, findNearDuplicate, overflowLine, renderPrompt, type BudgetReport } from "./rank.js";
import { canonicalFolder, MemoryError, createFileNoteStore, type NoteStore } from "./store.js";
import { DAILY_REMEMBER_LIMIT, createThreadGuard, type ThreadGuard } from "./taint.js";

export const MEMORY_DISABLED_ENV = ["ZERO_DISABLE_MEMORY", "ZERO_DISABLE_HUNT_MEMORY"] as const;
export const memoryDisabledByEnv = (env: NodeJS.ProcessEnv = process.env): boolean => MEMORY_DISABLED_ENV.some(name => /^(1|true)$/i.test(env[name] ?? ""));

export interface MemoryContext { notes: Note[]; omitted: Note[]; text: string }

/** What fits the prompt for a folder, and what was left out and why. Reads only; used by `0 memory list` and the page too. */
export function memoryOverview(store: NoteStore, folder?: string, budgetTokens?: number): BudgetReport {
  const identity = folder ? canonicalFolder(folder) : undefined;
  return fitToBudget(store.list(), { ...(identity ? { folder: identity } : {}), ...(budgetTokens ? { budgetTokens } : {}) });
}

/** The live notes for one thread, ranked and clamped to the budget, rendered as untrusted context. Records that they were shown (at most one file write per note per day). */
export function memoryContext(store: NoteStore, folder?: string, budgetTokens?: number): MemoryContext {
  if (!store.enabled()) return { notes: [], omitted: [], text: "" };
  const { shown, omitted } = memoryOverview(store, folder, budgetTokens);
  if (shown.length) store.markInjected(shown.map(note => note.id));
  return { notes: shown, omitted, text: renderPrompt(shown, omitted.length) };
}

/** "remember that X", "remember: X" or "remember X" typed by the operator as the whole message; undefined for anything else. */
export function parseRememberRequest(message: string): string | undefined {
  const text = message.trim();
  if (text.length > 500 || /\n\s*\n/.test(text)) return undefined;
  const note = /^(?:please\s+)?remember(?:\s+that\b|\s*:)?\s+([\s\S]{3,})$/i.exec(text)?.[1]?.trim();
  return note && !/^(?:to|me|how|when|why|what|if|whether)\b/i.test(note) ? note : undefined;
}

export interface MemoryToolArgs { action: "remember" | "update" | "forget"; note?: string; kind?: string; scope?: "folder" | "global"; id?: string }
export interface MemoryToolResult { id?: string; removed?: boolean; saved?: boolean; message: string }
export interface MemoryToolOptions { guard?: ThreadGuard; now?: () => Date; dailyLimit?: number }

const FROZEN = "Not changed: this thread read untrusted content (web, files, tool output), so it cannot change saved notes. Ask the user to change it in Memory.";
const NOT_SAVED = "Not saved: this thread read untrusted content (web, files, tool output), so it cannot add notes. Ask the user to add it in Memory.";

/** `remember` saves one note, `update` replaces the text of one by id, `forget` removes one. Without a guard the thread counts as tainted. */
export function runMemoryTool(store: NoteStore, folder: string | undefined, args: MemoryToolArgs, options: MemoryToolOptions = {}): MemoryToolResult {
  if (!store.enabled()) throw new Error("Memory is off.");
  const guard = options.guard ?? createThreadGuard("unknown", { tainted: true });
  try { return run(store, folder, args, guard, options); }
  catch (error) { if (error instanceof MemoryError) return { saved: false, message: error.message }; throw error; }
}

function run(store: NoteStore, folder: string | undefined, args: MemoryToolArgs, guard: ThreadGuard, options: MemoryToolOptions): MemoryToolResult {
  if (args.action === "forget") {
    if (!args.id) throw new Error("forget needs the id of a note.");
    if (guard.tainted) return { removed: false, message: FROZEN };
    const removed = store.remove(args.id);
    return { removed, message: removed ? `Forgot ${args.id}.` : `No note ${args.id}.` };
  }
  if (!args.note?.trim()) throw new Error(`${args.action} needs a note.`);
  const screen = screenText(args.note);
  if (!screen.ok) return { saved: false, message: screen.message };
  const day = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const capped = (): MemoryToolResult | undefined =>
    store.modelWritesOn(day) >= (options.dailyLimit ?? DAILY_REMEMBER_LIMIT) ? { saved: false, message: "Not saved: the daily limit of notes written by 0 is reached." }
      : guard.takeWrite() ? undefined : { saved: false, message: "Not saved: this thread has already saved the most notes it may. Tell the user what you wanted to keep." };
  if (args.action === "update") {
    if (!args.id) throw new Error("update needs the id of a note.");
    if (guard.tainted) return { saved: false, message: FROZEN };
    if (!store.list().some(note => note.id === args.id)) return { saved: false, message: `No note ${args.id}.` };
    const limited = capped();
    if (limited) return limited;
    const note = store.edit(args.id, args.note, { by: "model", thread: guard.thread });
    return note ? { id: note.id, saved: true, message: `Updated ${note.id}.` } : { saved: false, message: `No note ${args.id}.` };
  }
  // A note is in Memory or it is not: a thread that read untrusted content cannot add one, the same as it cannot change or forget one.
  if (guard.tainted) return { saved: false, message: NOT_SAVED };
  const kind: NoteKind | undefined = isKind(args.kind) ? args.kind : undefined;
  const scope = args.scope === "global" || !folder ? "global" : "folder";
  const identity = scope === "folder" ? canonicalFolder(folder!) : undefined;
  const near = findNearDuplicate(store.list().filter(note => note.scope === scope && note.folder === identity), screen.text);
  if (near) return { id: near.id, saved: false, message: `Not saved: a near-identical note already exists (${near.id}). Use action update with that id to change it.` };
  const limited = capped();
  if (limited) return limited;
  const note = store.add({ text: screen.text, scope, ...(scope === "folder" ? { folder } : {}), ...(kind ? { kind } : {}), source: "model", thread: guard.thread });
  return { id: note.id, saved: true, message: `Remembered ${note.id}.` };
}

export { MEMORY_HEADER, overflowLine };

/** Accepted or user-written `avoid` notes (known false positives, rejected approaches) as untrusted context for a verification prompt. Proposals and model-only notes never count. Never decides a verdict. */
export function verifyContext(store: NoteStore, folder?: string, budgetTokens = 600): string {
  if (!store.enabled()) return "";
  const identity = folder ? canonicalFolder(folder) : undefined;
  const { shown } = fitToBudget(store.list().filter(note => note.kind === "avoid" && isTrusted(note)), { ...(identity ? { folder: identity } : {}), budgetTokens });
  if (!shown.length) return "";
  return `${MEMORY_HEADER.split(" Add a lasting")[0]} Earlier decisions to avoid repeating, such as known false positives; current evidence still decides.\n${shown.map(note => `- ${note.text}`).join("\n")}`;
}

/** The scan pipelines' one call: open Memory (unless vetoed) and render its avoid notes. Memory trouble never fails a scan. */
export function scanVerifyContext(folder?: string): string {
  if (memoryDisabledByEnv()) return "";
  try { return verifyContext(createFileNoteStore(), folder); } catch { return ""; }
}
