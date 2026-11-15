// Browser error reporting for the one 0security engine.
//
// The page sends the engine ONLY a closed error category and scrubbed
// locations inside the built bundle (`assets/<file>.js:line:col`). Messages,
// stack text, origins, query strings, routes and absolute paths never leave
// this module. The engine validates the same shapes again and applies the
// operator's consent preference (off: drop, ask: store for review, automatic:
// send); the page cannot widen it.

export const CRASH_CATEGORIES = ["TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "Error", "unknown"] as const;
export type CrashCategory = (typeof CRASH_CATEGORIES)[number];

export interface CrashReportBody { name: CrashCategory; frames: string[]; surface: "web" }

export function crashCategory(error: unknown): CrashCategory {
  const name = error instanceof Error ? error.name : "";
  return (CRASH_CATEGORIES as readonly string[]).includes(name) && name !== "unknown" ? (name as CrashCategory) : error instanceof Error ? "Error" : "unknown";
}

const MAX_FRAMES = 16;
/** Matches `.../assets/name.js?x#y:LINE:COL` inside any stack format (V8, Firefox, Safari). */
const ASSET_FRAME = /(?:^|[/@( ])assets\/([A-Za-z0-9._-]{1,120}\.js)(?:\?[^\s:)]*)?:(\d{1,7}):(\d{1,7})/;

export function scrubFrames(stack: unknown): string[] {
  if (typeof stack !== "string") return [];
  const frames: string[] = [];
  for (const line of stack.slice(0, 16_384).split("\n").slice(0, 64)) {
    const match = ASSET_FRAME.exec(line);
    if (match && Number(match[2]) > 0 && Number(match[3]) > 0) frames.push(`assets/${match[1]}:${match[2]}:${match[3]}`);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

export function crashReportBody(error: unknown): CrashReportBody {
  return { name: crashCategory(error), frames: error instanceof Error ? scrubFrames(error.stack) : [], surface: "web" };
}

export interface CrashReporterOptions {
  post: (body: CrashReportBody) => Promise<unknown>;
  now?: () => number;
  windowMs?: number;
  maxPerSession?: number;
}

/** De-duplicates bursts (same category + top frame within a minute) and caps a session. Never throws. */
export function createCrashReporter(options: CrashReporterOptions): (error: unknown) => boolean {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 60_000;
  const max = options.maxPerSession ?? 5;
  const seen = new Map<string, number>();
  let sent = 0;
  return (error) => {
    try {
      const body = crashReportBody(error);
      const key = `${body.name}|${body.frames[0] ?? ""}`;
      const at = now();
      for (const [k, t] of seen) if (at - t >= windowMs) seen.delete(k);
      if (seen.has(key) || sent >= max) return false;
      seen.set(key, at); sent += 1;
      void Promise.resolve(options.post(body)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listenable = { addEventListener(type: string, listener: (event: any) => void): void; removeEventListener(type: string, listener: (event: any) => void): void };

/** Window-level last-resort listeners. Returns an uninstaller. */
export function installWindowCrashListeners(target: Listenable, report: (error: unknown) => boolean): () => void {
  const onError = (event: { error?: unknown }) => { report(event.error ?? new Error("Error")); };
  const onRejection = (event: { reason?: unknown }) => { report(event.reason); };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => { target.removeEventListener("error", onError); target.removeEventListener("unhandledrejection", onRejection); };
}
