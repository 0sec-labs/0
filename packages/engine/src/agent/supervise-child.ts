// Supervise a spawned child under a hard wallclock ceiling with bounded output.
import type { ChildProcess } from "node:child_process";

export type ChildOutcome =
  | { kind: "exit"; exitCode: number; combined: string; durationMs: number }
  | { kind: "timeout"; partial: string; durationMs: number }
  | { kind: "error"; message: string; durationMs: number; cancelled?: boolean };

export interface SuperviseChildOptions {
  signal?: AbortSignal;
}

const CHILD_CANCELLED_BY_OPERATOR_MESSAGE = "command cancelled by operator";
const CHILD_GRACE_MS = 2_000;
const CHILD_MAX_BUFFER = 2 * 1024 * 1024;

/**
 * Supervise an already-spawned child under a hard wallclock ceiling: capture
 * bounded stdout/stderr, and on timeout signal the whole process group (SIGTERM
 * → SIGKILL after a short grace) so forked helpers die too, returning PARTIAL
 * output rather than hanging unbounded. ENOENT (binary not installed) arrives
 * as a child `error` event and is surfaced as a structured error outcome.
 *
 */
export function superviseChild(
  child: ChildProcess,
  effectiveTimeoutMs: number,
  startedAt: number,
  options?: SuperviseChildOptions,
): Promise<ChildOutcome> {
  return new Promise((resolvePromise) => {
    const signal = options?.signal;
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdoutLen >= CHILD_MAX_BUFFER) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderrLen >= CHILD_MAX_BUFFER) return;
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });

    const collected = (): string =>
      (stdoutChunks.join("") + "\n" + stderrChunks.join("")).trim();

    const killGroup = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (typeof pid !== "number") return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          /* already dead */
        }
      }
    };

    const terminate = () => {
      killGroup("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!settled) killGroup("SIGKILL");
        }, CHILD_GRACE_MS);
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
    }, effectiveTimeoutMs);
    timer.unref?.();

    const settle = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(outcome);
    };

    child.on("error", (err: Error) => {
      settle({
        kind: "error",
        message: err.message,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
      const durationMs = Date.now() - startedAt;
      if (cancelled) {
        settle({
          kind: "error",
          message: CHILD_CANCELLED_BY_OPERATOR_MESSAGE,
          durationMs,
          cancelled: true,
        });
        return;
      }
      if (timedOut) {
        settle({ kind: "timeout", partial: collected(), durationMs });
        return;
      }
      const exitCode = typeof code === "number" ? code : sig ? 1 : 0;
      settle({ kind: "exit", exitCode, combined: collected(), durationMs });
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
