/**
 * Code-eval tool definitions (`js_eval` / `python_eval`).
 *
 * Two thin, effectful "run this snippet" tools that let the agent evaluate a
 * short JavaScript or Python program and see its stdout/stderr, exit code, and
 * wall-clock duration rendered as a rich CODE card in the TUI (the code block +
 * its output, collapsible — mirroring oh-my-pi's eval card).
 *
 * SECURITY: these are NOT a new sandbox. The runtime handlers (`jsEval` /
 * `pythonEval` on the `ToolExecutor` in agent/tools.ts) are thin wrappers that
 * build a `node` / `python3` heredoc command and delegate to the SAME
 * `shellExec` path the `bash` tool uses — so they inherit every scope / egress /
 * auth-header / rate-limit guard and the wallclock ceiling verbatim. They are
 * gated EXACTLY like `bash`: classified `network-capable` (see
 * `plugins/capability-classification.ts`) and deliberately kept OUT of
 * `READ_ONLY_TOOLS`, so the operator-approval and recon-refusal gates treat
 * them as effectful.
 *
 * Pure `ToolDefinition` metadata here (name / description / parameter schema).
 * The ./tools/index.ts barrel merges this into the canonical `TOOL_DEFINITIONS`
 * registry; ./tools/dispatch.ts merges the route map; the handlers live on the
 * `ToolExecutor` class in agent/tools.ts.
 */
import type { ToolDefinition } from "../types.js";

/** The two languages the eval tools support. */
export type EvalLanguage = "javascript" | "python";

export const evalToolDefinitions: Record<string, ToolDefinition> = {
  js_eval: {
    name: "js_eval",
    description:
      "Evaluate a short JavaScript program with Node.js and capture its stdout, " +
      "stderr, exit code, and duration. Use for quick computation, parsing, " +
      "encoding/decoding, or checking a snippet's behaviour. `console.log(...)` " +
      "to print results. This shells out through the same guarded executor as " +
      "the bash tool (scope, egress, and rate-limit guards apply), so it is " +
      "effectful and requires the same approval — prefer read-only tools for " +
      "pure analysis.",
    parameters: {
      code: {
        type: "string",
        description: "JavaScript source to run with `node`. Print results with console.log().",
      },
      timeout: {
        type: "number",
        description: "Per-call timeout in seconds (default 30, max 120). Clamped to the bash wallclock ceiling.",
      },
    },
    required: ["code"],
  },

  python_eval: {
    name: "python_eval",
    description:
      "Evaluate a short Python 3 program and capture its stdout, stderr, exit " +
      "code, and duration. Use for quick computation, parsing, crypto, or " +
      "encode/decode work. `print(...)` to emit results. This shells out through " +
      "the same guarded executor as the bash tool (scope, egress, and " +
      "rate-limit guards apply), so it is effectful and requires the same " +
      "approval. For a PERSISTENT compute-only REPL whose state survives across " +
      "calls, use `python_exec` instead.",
    parameters: {
      code: {
        type: "string",
        description: "Python 3 source to run with `python3`. Print results with print().",
      },
      timeout: {
        type: "number",
        description: "Per-call timeout in seconds (default 30, max 120). Clamped to the bash wallclock ceiling.",
      },
    },
    required: ["code"],
  },
};

// Tool-name → ToolExecutor handler-method name (0sec#614). Co-located with this
// domain's definitions so a new tool adds its route here, not in a shared
// dispatch switch. Assembled by ./dispatch.ts; resolved off the executor
// instance in agent/tools.ts (the handler bodies stay private methods).
export const evalDispatch: Record<string, string> = {
  js_eval: "jsEval",
  python_eval: "pythonEval",
};

/** The validated shape of a `js_eval` / `python_eval` call's arguments. */
export interface ParsedEvalArgs {
  code: string;
  timeout?: number;
}

export type EvalArgsResult =
  | { ok: true; value: ParsedEvalArgs }
  | { ok: false; error: string };

/**
 * Validate the model-supplied eval arguments. Pure and dependency-free so the
 * handler and its unit test share one source of truth: `code` must be a
 * non-empty string; `timeout`, when present, must be a finite positive number.
 */
export function parseEvalArgs(args: Record<string, unknown> | undefined): EvalArgsResult {
  const code = typeof args?.code === "string" ? args.code : undefined;
  if (code === undefined) return { ok: false, error: "code is required and must be a string" };
  if (code.trim().length === 0) return { ok: false, error: "code must not be empty" };

  let timeout: number | undefined;
  if (args?.timeout !== undefined) {
    if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0) {
      return { ok: false, error: "timeout must be a positive number of seconds" };
    }
    timeout = args.timeout;
  }
  return { ok: true, value: { code, timeout } };
}

/** The interpreter invoked for each language. */
function interpreterFor(language: EvalLanguage): string {
  return language === "python" ? "python3" : "node";
}

/**
 * Pick a heredoc delimiter guaranteed not to collide with any line in `code`.
 * The base token is fixed for stable, testable output; a counter is appended
 * only in the (pathological) case the code already contains the token on its
 * own line.
 */
function heredocDelimiter(code: string): string {
  const lines = new Set(code.split("\n").map((l) => l.trim()));
  let delimiter = "OSEC_EVAL_EOF";
  let n = 0;
  while (lines.has(delimiter)) {
    n += 1;
    delimiter = `OSEC_EVAL_EOF_${n}`;
  }
  return delimiter;
}

/**
 * Build the shell command that runs `code` under the given interpreter.
 *
 * The source is fed on stdin via a QUOTED heredoc (`<<'DELIM'`), so the shell
 * performs no expansion or word-splitting on it — there is no quote-escaping
 * injection surface, and the code appears LITERALLY in the command string, so
 * `shellExec`'s static URL / egress scope guards can still inspect it (a
 * base64-encoded pipeline would have hidden any embedded URL from those
 * guards). This is why the eval tools are a safe thin wrapper over `shellExec`
 * rather than a separate execution path.
 */
export function buildEvalCommand(language: EvalLanguage, code: string): string {
  const delimiter = heredocDelimiter(code);
  return `${interpreterFor(language)} <<'${delimiter}'\n${code}\n${delimiter}`;
}
