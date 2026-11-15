/** Mirrors the server's /api/console/project/check-directory reply. */
export type FolderCheckState = "checking" | "waiting" | "allowed" | "blocked" | "timeout" | "error";
export interface FolderCheckReply { state: FolderCheckState; path: string; folder: string | null; message?: string; privacy?: boolean; canPrompt?: boolean }

/** What the picker shows for each state. `pending` states keep the chip unchanged and the button spinning. */
export function folderCheckView(reply: Pick<FolderCheckReply, "state" | "message" | "folder">): { pending: boolean; text: string | null; tone: "info" | "error" | null; retry: boolean } {
  switch (reply.state) {
    case "checking": return { pending: true, text: reply.message ?? "Checking the folder…", tone: "info", retry: false };
    case "waiting": return { pending: true, text: reply.message ?? `Waiting for macOS: click Allow in the dialog that appeared${reply.folder ? ` (${reply.folder})` : ""}.`, tone: "info", retry: false };
    case "allowed": return { pending: false, text: null, tone: null, retry: false };
    case "timeout": return { pending: false, text: reply.message ?? "macOS is still waiting for your answer.", tone: "error", retry: true };
    default: return { pending: false, text: reply.message ?? "Zero couldn't read that folder.", tone: "error", retry: false };
  }
}

export interface FolderCheckRun {
  request: (input: { path: string; retry: boolean }, signal: AbortSignal) => Promise<FolderCheckReply>;
  onState: (reply: FolderCheckReply) => void;
  signal: AbortSignal;
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  /** Safety net above the server's own 60 s limit, in case replies stop changing. */
  maxMs?: number;
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Asks the server whether it may read `path`, polling while macOS is deciding. Resolves with the final reply, or null when
 * the run was cancelled. A server without the endpoint (older build, remote engine) counts as allowed: the folder switch
 * itself still validates.
 */
export async function runFolderCheck(path: string, run: FolderCheckRun): Promise<FolderCheckReply | null> {
  const sleep = run.sleep ?? wait;
  const started = Date.now();
  let retry = true;
  for (;;) {
    let reply: FolderCheckReply;
    try { reply = await run.request({ path, retry }, run.signal); }
    catch { return run.signal.aborted ? null : { state: "allowed", path, folder: null }; }
    if (run.signal.aborted) return null;
    retry = false;
    run.onState(reply);
    if (reply.state !== "checking" && reply.state !== "waiting") return reply;
    if (Date.now() - started > (run.maxMs ?? 70_000)) return { ...reply, state: "timeout", message: reply.message ?? "macOS is still waiting for your answer." };
    await sleep(run.pollMs ?? 700, run.signal);
    if (run.signal.aborted) return null;
  }
}
