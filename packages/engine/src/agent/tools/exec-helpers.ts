// Subprocess execution helpers: bash wallclock ceiling, install hints and edit-card metadata.
// Extracted verbatim from ../tools.ts; the public API is re-exported there.
import { spawn } from "node:child_process";
import type { ToolResultMeta } from "../types.js";
import { BASH_TIMEOUT_MS, resolveLimit } from "../../shared/limits.js";
import { trackExecutionResourceSpawn } from "../execution-resource-registry.js";

// ── Bash tool wallclock ceiling ──
//
// Hard upper bound on how long a single `bash` tool invocation may run before
// the subprocess (and its descendants) are forcibly reaped. This defends
// against scripts that block on network I/O without a client-side timeout —
// the canonical case being `python3 -c 'requests.post(…)'`, where `requests`
// has no default timeout and a hung remote can wedge the agent indefinitely.
//
// See https://github.com/0sec-labs/0security/issues/181

export const DEFAULT_BASH_WALLCLOCK_MS = BASH_TIMEOUT_MS.default;
export const SUBAGENT_MODEL_TIMEOUT_MS = 120_000;
export const BASH_GRACE_MS = 2_000;

export function resolveBashWallclockCeilingMs(): number {
  return resolveLimit(BASH_TIMEOUT_MS);
}

export type BashOutcome =
  | { kind: "exit"; exitCode: number; combined: string }
  | { kind: "timeout"; partial: string }
  | { kind: "error"; message: string };

export interface BashRunOptions {
  cwd?: string;
  timeoutMs: number;
  ceilingMs: number;
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Secret values that were put in `env` for this run. They are masked in everything that comes back. */
  redact?: readonly string[];
}

/** Replace every occurrence of each secret value (4+ characters) with a marker. */
export function redactSecrets(text: string, secrets: readonly string[] | undefined): string {
  let out = text;
  for (const secret of secrets ?? []) if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out;
}
const redactOutcome = (o: BashOutcome, secrets: readonly string[] | undefined): BashOutcome => {
  if (!secrets?.length) return o;
  return o.kind === "exit" ? { ...o, combined: redactSecrets(o.combined, secrets) } : o.kind === "timeout" ? { ...o, partial: redactSecrets(o.partial, secrets) } : { ...o, message: redactSecrets(o.message, secrets) };
};

/**
 * Run a shell command with a hard wallclock ceiling. The child is its own
 * process group leader (`detached: true`); on timeout we signal the entire
 * group so any forked grandchildren (`python3 -c '…'`, `curl`, etc.) die
 * alongside the shell. SIGTERM first, then SIGKILL after a short grace.
 *
 * Exported via the module-private `runBashWithWallclock` helper so the bash
 * tool's `shellExec` can consume a typed outcome rather than wrapping the
 * raw spawn lifecycle inline.
 */
export async function runBashWithWallclock(
  command: string,
  opts: BashRunOptions,
): Promise<BashOutcome> {
  if (opts.signal?.aborted) return { kind: "error", message: "bash tool cancelled before dispatch" };
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = trackExecutionResourceSpawn(() => spawn("/bin/bash", ["-c", command], {
        env: opts.env,
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      }), true);
    } catch (err) {
      resolvePromise({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const MAX_BUFFER = 1024 * 1024; // 1MB, matches prior execSync limit
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let settled = false;
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdoutLen >= MAX_BUFFER) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderrLen >= MAX_BUFFER) return;
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });

    const collected = (): string =>
      (stdoutChunks.join("") + "\n" + stderrChunks.join("")).trim();

    const killGroup = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (typeof pid !== "number") return;
      // Negative pid targets the process group (because we spawned detached).
      try {
        process.kill(-pid, signal);
      } catch {
        // Process may already be gone; fall back to per-pid kill.
        try {
          process.kill(pid, signal);
        } catch {
          /* already dead */
        }
      }
    };

    const terminate = () => {
      killGroup("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => { if (!settled) killGroup("SIGKILL"); }, BASH_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const onAbort = () => {
      if (settled) return;
      if (!timedOut) cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    timer.unref?.();

    const settle = (outcome: BashOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise(redactOutcome(outcome, opts.redact));
    };

    child.on("error", (err: Error) => {
      settle({ kind: "error", message: err.message });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (cancelled) {
        settle({ kind: "error", message: "bash tool cancelled by operator" });
        return;
      }
      if (timedOut) {
        settle({ kind: "timeout", partial: collected() });
        return;
      }
      // Process killed by signal but not from our timer — surface as exit -1
      // with whatever output we captured. Preserves prior execSync behaviour
      // of returning combined output for non-zero exits.
      const exitCode = typeof code === "number" ? code : signal ? 1 : 0;
      settle({ kind: "exit", exitCode, combined: collected() });
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
  });
}

/**
 * Build the display-only edit-card {@link ToolResultMeta} for a `str_replace`
 * result — the same `kind:"edit"` card `apply_patch` emits, so the TUI renders
 * one edit card for either tool. Added/removed are the new/old block line
 * counts multiplied by the number of replacements; the diff body shows the
 * removed block (`-`) then the inserted block (`+`). Pure; never throws.
 */
export function buildStrReplaceMeta(
  logicalPath: string,
  oldString: string,
  newString: string,
  replacements: number,
): ToolResultMeta {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const diff = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join("\n");
  return {
    kind: "edit",
    path: logicalPath,
    added: newLines.length * replacements,
    removed: oldLines.length * replacements,
    diff,
  };
}
