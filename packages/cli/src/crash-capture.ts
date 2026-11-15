/**
 * Last-resort crash capture for the 0security engine.
 *
 * Installed once, as early as possible, by the shared entry point
 * (`index.ts`), so the terminal and `0 web` (the same engine in-process) report
 * through one path to one Sentry project, distinguished only by `surface`.
 *
 * Observable behavior on a crash is exactly what Node does by default:
 * the error is written to stderr and the process exits 1. Capture is purely
 * additive and fail-soft. The report carries only finite categories, runtime
 * labels, an allowlisted command path and scrubbed built-in stack locations
 * (see `buildDiagnosticFeedback`); the error message is never read into it.
 * Whether it is dropped, stored for review, or sent is decided by
 * `handleDiagnosticReport` from the operator's consent preference.
 */

import type { DiagnosticInfo, DiagnosticSurface } from "./state/feedback.js";
import type { DiagnosticOutcome } from "./state/pending-diagnostics.js";

/** Never hold the exit for longer than this, whatever the transport does. */
export const CRASH_EXIT_BUDGET_MS = 2000;

let knownCommandPaths: ReadonlySet<string> = new Set();

/** Register the closed allowlist (the command tree) used to label a crash with its command. */
export function setCrashCommandPaths(paths: Iterable<string>): void {
  knownCommandPaths = new Set(paths);
}

/** Walk a commander-style tree into "a", "a b" paths (depth <= 3). */
export function commandPathsOf(program: { commands: readonly { name(): string; commands: readonly unknown[] }[] }): string[] {
  const out: string[] = [];
  const walk = (commands: readonly { name(): string; commands: readonly unknown[] }[], prefix: string[]) => {
    for (const command of commands) {
      const words = [...prefix, command.name()];
      out.push(words.join(" "));
      if (words.length < 3) walk(command.commands as never, words);
    }
  };
  walk(program.commands, []);
  return out;
}

/** Longest allowlisted command path at the front of argv (flags and values never qualify). */
export function crashCommandFromArgv(argv: readonly string[], known: ReadonlySet<string> = knownCommandPaths): string | undefined {
  const words = argv.slice(2);
  if (words.length === 0) return known.has("web") || known.size === 0 ? "web" : undefined;
  const leading: string[] = [];
  for (const word of words) {
    if (word.startsWith("-") || leading.length === 3) break;
    leading.push(word);
  }
  for (let n = leading.length; n > 0; n--) {
    const candidate = leading.slice(0, n).join(" ");
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

export interface CrashCaptureOptions {
  surface: DiagnosticSurface;
  /** Test seams. Production uses the process, real settings and the real transport. */
  proc?: Pick<NodeJS.Process, "on" | "argv" | "version" | "platform" | "arch"> & { exit(code?: number): never | void };
  stderr?: (text: string) => void;
  report?: (info: DiagnosticInfo) => Promise<DiagnosticOutcome>;
  budgetMs?: number;
  version?: string;
  now?: () => Date;
}

async function defaultReport(info: DiagnosticInfo): Promise<DiagnosticOutcome> {
  const { handleDiagnosticReport } = await import("./state/pending-diagnostics.js");
  return handleDiagnosticReport(info);
}

/** What Node prints for an uncaught error, without the source excerpt. */
function crashText(error: unknown, proc: { version: string }): string {
  let body: string;
  try {
    body = error instanceof Error && typeof error.stack === "string" ? error.stack : `Uncaught ${typeof error === "string" ? error : JSON.stringify(error) ?? String(error)}`;
  } catch {
    body = "Uncaught exception";
  }
  return `\n${body}\n\nNode.js ${proc.version}\n`;
}

/** Returns a function that removes the handlers (tests only). */
export function installCrashCapture(options: CrashCaptureOptions): () => void {
  const proc = options.proc ?? process;
  const write = options.stderr ?? ((text: string) => { try { process.stderr.write(text); } catch { /* stderr may be closed */ } });
  const report = options.report ?? defaultReport;
  const budget = options.budgetMs ?? CRASH_EXIT_BUDGET_MS;
  let crashing = false;

  const onCrash = (error: unknown) => {
    // A crash while handling a crash exits at once with the same code.
    if (crashing) { proc.exit(1); return; }
    crashing = true;
    write(crashText(error, proc));
    const exit = () => { proc.exit(1); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = (async () => {
      const info: DiagnosticInfo = {
        kind: "runtime", surface: options.surface,
        version: options.version ?? (await import("@0/engine/shared").then((m) => m.VERSION).catch(() => "unknown")),
        platform: proc.platform, arch: proc.arch, runtime: "node", runtimeVersion: proc.version.replace(/^v/, ""),
        error, timestamp: (options.now?.() ?? new Date()).toISOString(),
        ...(() => { const command = crashCommandFromArgv(proc.argv); return command ? { command } : {}; })(),
      };
      await report(info);
    })().catch(() => {});
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, budget); });
    void Promise.race([capture, deadline]).then(() => { if (timer) clearTimeout(timer); exit(); }, exit);
  };

  proc.on("uncaughtException", onCrash);
  // Node's default for an unhandled rejection is to raise it as an uncaught
  // exception (exit 1, stack on stderr). Registering a handler removes that
  // default, so do exactly that here.
  const onRejection = (reason: unknown) => onCrash(reason);
  proc.on("unhandledRejection", onRejection);
  return () => {
    const p = proc as unknown as NodeJS.Process;
    p.removeListener?.("uncaughtException", onCrash);
    p.removeListener?.("unhandledRejection", onRejection);
  };
}
