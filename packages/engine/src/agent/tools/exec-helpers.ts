// Subprocess execution helpers: bash wallclock ceiling, run_command pipelines, install hints and edit-card metadata.
// Extracted verbatim from ../tools.ts; the public API is re-exported there.
import { spawnSync, spawn } from "node:child_process";
import type { ToolResult, ToolResultMeta } from "../types.js";
import { formatTruncated } from "../output-truncation.js";
import { BASH_TIMEOUT_MS, resolveLimit } from "../../shared/limits.js";
import { sanitizedEnv } from "../sanitized-env.js";
import { trackExecutionResourceSpawn } from "../execution-resource-registry.js";
import type { ToolHealthRecordInput } from "../tool-health.js";

// ── Bash tool wallclock ceiling ──
//
// Hard upper bound on how long a single `bash` tool invocation may run before
// the subprocess (and its descendants) are forcibly reaped. This defends
// against scripts that block on network I/O without a client-side timeout —
// the canonical case being `python3 -c 'requests.post(…)'`, where `requests`
// has no default timeout and a hung remote can wedge the agent indefinitely.
//
// See https://github.com/0sec-labs/0/issues/181

export const DEFAULT_BASH_WALLCLOCK_MS = BASH_TIMEOUT_MS.default;
/**
 * Per-request model timeout for spawned subagents. Matches the runtime
 * default and the other fork sites: non-streaming wires (e.g. OpenRouter
 * chat completions) must finish the whole generation inside this window.
 */
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
}

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
      resolvePromise(outcome);
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


// run_command subprocess stdout/stderr ceiling. The old 1 MiB limit made a
// broad `rg`/`grep` sweep over a large repo abort with `spawnSync … ENOBUFS`
// (stdout buffer reached maxBuffer size limit) instead of returning results.
// 64 MiB comfortably holds a wide sweep; on the rare overflow we now return
// the partial capture with a truncation note rather than crashing.
export const MAX_COMMAND_BUFFER = 64 * 1024 * 1024;

/**
 * Install-hint for optional binaries the audit agent can drive through
 * run_command. Used to turn a raw ENOENT spawn failure into an actionable
 * "not installed — skipping (install: …)" message + tool-health event.
 */
export const OPTIONAL_BINARY_INSTALL_HINTS: Record<string, string> = {
  semgrep: "pip install semgrep  (or: brew install semgrep)",
  codeql: "https://github.com/github/codeql-cli-binaries/releases",
  foxguard: "internal tool — provision on the runner image",
  jq: "brew install jq  (or: apt-get install jq)",
};

/**
 * Install hints for the structured external scanners (run_sqlmap / run_nmap /
 * run_ffuf / run_nuclei). Used to turn an ENOENT (binary absent) into a
 * graceful, actionable skip instead of a raw spawn error.
 */
export const SCANNER_INSTALL_HINTS: Record<string, string> = {
  sqlmap: "apt-get install sqlmap  (or: pip install sqlmap)",
  nmap: "apt-get install nmap  (or: brew install nmap)",
  ffuf: "go install github.com/ffuf/ffuf/v2@latest  (or: brew install ffuf)",
  nuclei: "go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest  (or: brew install nuclei)",
};

export function executePipeline(
  segments: string[][],
  cwd: string,
  timeout: number,
  onHealth?: (input: ToolHealthRecordInput) => void,
): ToolResult {
  let stdin: string | Buffer | undefined;

  for (const tokens of segments) {
    const bin = tokens[0];
    const result = spawnSync(bin, tokens.slice(1), {
      cwd,
      timeout,
      input: stdin,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: sanitizedEnv(),
      encoding: "utf-8",
    });

    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;

      // ENOBUFS — output exceeded even the raised ceiling. Return the partial
      // capture (spawnSync fills stdout up to maxBuffer before aborting) with a
      // clear truncation note rather than a hard crash. Classify as a
      // buffer-limit tool-health event so the operator sees WHY it was clipped.
      if (err.code === "ENOBUFS") {
        onHealth?.({
          tool: "run_command",
          category: "buffer-limit",
          message: `'${bin}' output exceeded the ${Math.round(MAX_COMMAND_BUFFER / (1024 * 1024))}MB buffer; returning partial results.`,
          remedy: "Narrow the query (add a path filter, -m/--max-count, or --max-filesize) or pipe through head.",
        });
        const partial = typeof result.stdout === "string" ? result.stdout : "";
        const note = `\n[truncated: '${bin}' output exceeded the ${Math.round(MAX_COMMAND_BUFFER / (1024 * 1024))}MB buffer — results are PARTIAL. Narrow the search (path filter / -m / --max-filesize) for the full set.]`;
        // Continue the pipeline with the partial stdout as the next stdin so a
        // trailing `| head`/`| wc` still produces a bounded, useful result.
        stdin = partial;
        if (segments[segments.length - 1] === tokens) {
          return { success: true, output: formatTruncated(partial, { mode: "bytes", limit: 10_000 - Buffer.byteLength(note, "utf8") }) + note };
        }
        continue;
      }

      // ENOENT — the binary isn't installed on this runner (semgrep/codeql/…).
      // Graceful skip: a clear "not installed — skipping" result that does NOT
      // read as a hard crash, plus a missing-binary tool-health event.
      if (err.code === "ENOENT") {
        const hint = OPTIONAL_BINARY_INSTALL_HINTS[bin];
        onHealth?.({
          tool: bin,
          category: "missing-binary",
          message: `'${bin}' is not installed on this runner — skipping.`,
          ...(hint ? { remedy: `install: ${hint}` } : {}),
        });
        return {
          success: true,
          output: {
            skipped: true,
            reason: `'${bin}' not installed — skipping.`,
            ...(hint ? { install: hint } : {}),
          },
        };
      }

      throw result.error;
    }

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) {
      return {
        success: false,
        output: null,
        error: formatTruncated(output, { mode: "bytes", limit: 2_000 }) || `Command exited with status ${result.status}`,
      };
    }

    stdin = result.stdout ?? "";
  }

  return {
    success: true,
    output: typeof stdin === "string" ? formatTruncated(stdin, { mode: "bytes", limit: 10_000 }) : "",
  };
}

/**
 * Build the display-only edit-card {@link ToolResultMeta} for an `apply_patch`
 * result. Counts added/removed lines and extracts a hunk diff body from the
 * patch envelope, and names the path(s) the ops touched. Pure; never throws
 * (a display sidecar must never take down a successful edit).
 */
export function buildEditCardMeta(
  patchInput: string,
  applied: ReadonlyArray<{ kind: string; path: string }>,
): ToolResultMeta {
  let added = 0;
  let removed = 0;
  const diffLines: string[] = [];
  for (const line of patchInput.split("\n")) {
    // Envelope control lines: `*** Begin Patch`, `*** Update File: …`, `@@ …`.
    if (line.startsWith("*** ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      added += 1;
      diffLines.push(line);
    } else if (line.startsWith("-")) {
      removed += 1;
      diffLines.push(line);
    } else {
      diffLines.push(line);
    }
  }
  const paths = Array.from(new Set(applied.map((a) => a.path)));
  const path = paths.length > 0 ? paths.join(", ") : "(patch)";
  return {
    kind: "edit",
    path,
    added,
    removed,
    diff: diffLines.join("\n").trim(),
  };
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
