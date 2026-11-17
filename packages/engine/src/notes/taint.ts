// Who may write what, decided by what the thread has read. Pure rules, no I/O.
//
// A thread is TAINTED once any tool other than a short list of known-local ones has returned:
// web pages, browser, HTTP, repository file content, shell output, MCP and extension results,
// sub-agent output. Fail closed: a tool the list does not know taints. The user's own prompt
// and answers to ask_operator do not taint. A tainted thread's model-written notes are proposals.
import type { NoteStatus } from "./core.js";

/** Tools whose results carry nothing from outside the user and the host. Adding one is a reviewed decision. */
export const TRUSTED_TOOLS: ReadonlySet<string> = new Set([
  "memory", "ask_operator", "update_todos", "write_todos", "plan", "done", "visualize", "list_skills", "load_skill", "read_skill", "update_target", "list_tools", "load_tool",
]);

export const isUntrustedTool = (name: string): boolean => !TRUSTED_TOOLS.has(name);

export const THREAD_REMEMBER_LIMIT = 5;
export const DAILY_REMEMBER_LIMIT = 20;

export interface ThreadGuard {
  readonly thread: string;
  readonly tainted: boolean;
  /** Record that a tool result entered the thread. */
  sawTool(name: string): void;
  /** Mark the thread tainted without naming a tool (a restored thread, an autonomous scan). */
  taint(): void;
  /** Count one model-initiated write; false once the per-thread limit is reached. */
  takeWrite(limit?: number): boolean;
  readonly writes: number;
}

export function createThreadGuard(thread: string, options: { tainted?: boolean } = {}): ThreadGuard {
  let tainted = options.tainted === true;
  let writes = 0;
  return {
    thread,
    get tainted() { return tainted; },
    get writes() { return writes; },
    sawTool(name) { if (isUntrustedTool(name)) tainted = true; },
    taint() { tainted = true; },
    takeWrite(limit = THREAD_REMEMBER_LIMIT) { if (writes >= limit) return false; writes++; return true; },
  };
}

/** Model-initiated notes commit only from a clean thread; everything else waits for review. */
export const modelNoteStatus = (guard: Pick<ThreadGuard, "tainted">): NoteStatus => (guard.tainted ? "proposed" : "live");
