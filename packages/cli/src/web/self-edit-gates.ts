/**
 * Self-edit gate runner. Lives in the live dashboard process, outside the
 * agent-editable concept: it is on the protected-path list, results are
 * written to a state directory outside the worktree, and the agent has no
 * route that can mark a gate green.
 *
 * Order matters. The protected-path diff check runs FIRST and, if it fails,
 * no further step runs: typecheck/build/test execute code from the worktree
 * (package scripts, vitest config), so they must never run over a diff that
 * touched build configuration or guard code. Every error path is a failure.
 */
import { createHash } from "node:crypto";
import { checkProtectedPaths, protectedCheckFailure, type ProtectedCheck } from "./self-edit-policy.js";

export type GateStatus = "pending" | "running" | "passed" | "failed" | "skipped";
export interface GateStep { id: string; label: string; status: GateStatus; durationMs?: number; detail?: string }
export interface GateResult {
  status: "running" | "passed" | "failed";
  startedAt: number;
  finishedAt?: number;
  /** Commit the worktree was at; an apply step must re-verify it still matches. */
  headSha?: string;
  /** Hash of the full diff against base; changes if the worktree changes after the gate. */
  diffHash?: string;
  steps: GateStep[];
  protected: ProtectedCheck;
}
export interface ExecResult { code: number | null; output: string; timedOut: boolean }
export type Exec = (command: string, args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<ExecResult>;

export interface GateCommand { command: string; args: string[] }
export interface GateDefinition { id: string; label: string; timeoutMs: number; commands: (base: string) => GateCommand[] }

const pnpm = (...args: string[]): GateCommand => ({ command: "pnpm", args });
export const GATE_DEFINITIONS: readonly GateDefinition[] = [
  { id: "typecheck", label: "Typecheck (engine, cli, web)", timeoutMs: 300_000,
    commands: () => [pnpm("--filter", "@0/engine", "--filter", "@0/cli", "--filter", "@0/web", "--parallel", "exec", "tsc", "--noEmit")] },
  { id: "web-build", label: "Web build", timeoutMs: 300_000, commands: () => [pnpm("--filter", "@0/web", "build")] },
  { id: "tests", label: "Tests for changed files", timeoutMs: 300_000,
    commands: base => ["@0/cli", "@0/web"].map(name => pnpm("--filter", name, "exec", "vitest", "run", "--changed", base, "--passWithNoTests")) },
];

const MAX_DETAIL = 4000;
const tail = (text: string) => text.length > MAX_DETAIL ? text.slice(-MAX_DETAIL) : text;

export interface RunGatesOptions {
  worktree: string;
  /** Commit the self branch forked from. */
  base: string;
  exec: Exec;
  now?: () => number;
  onUpdate?: (result: GateResult) => void;
  definitions?: readonly GateDefinition[];
}

export async function runGates(options: RunGatesOptions): Promise<GateResult> {
  const { worktree, base, exec } = options;
  const now = options.now ?? Date.now;
  const definitions = options.definitions ?? GATE_DEFINITIONS;
  const result: GateResult = {
    status: "running", startedAt: now(), protected: { ok: false, files: [], hits: [] },
    steps: [{ id: "protected-paths", label: "Protected paths untouched", status: "pending" }, ...definitions.map(d => ({ id: d.id, label: d.label, status: "pending" as GateStatus }))],
  };
  const publish = () => options.onUpdate?.(structuredClone(result));
  const step = (id: string) => result.steps.find(item => item.id === id)!;
  const git = async (...args: string[]) => {
    const out = await exec("git", args, { cwd: worktree, timeoutMs: 30_000 });
    if (out.code !== 0 || out.timedOut) throw new Error(`git ${args[0]} failed: ${tail(out.output)}`);
    return out.output;
  };
  const finish = (status: "passed" | "failed") => {
    for (const item of result.steps) if (item.status === "pending" || item.status === "running") item.status = "skipped";
    result.status = status; result.finishedAt = now(); publish();
    return result;
  };

  publish();
  const protectedStep = step("protected-paths");
  protectedStep.status = "running"; publish();
  const started = now();
  try {
    result.headSha = (await git("rev-parse", "HEAD")).trim();
    const tracked = await git("diff", "--name-only", "--no-renames", "-z", base);
    const untracked = await git("ls-files", "--others", "--exclude-standard", "-z");
    const files = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
    result.protected = checkProtectedPaths(files);
    result.diffHash = createHash("sha256").update(await git("diff", "--binary", "--no-renames", base)).update(untracked).digest("hex");
  } catch (error) {
    result.protected = protectedCheckFailure(error);
  }
  protectedStep.durationMs = now() - started;
  protectedStep.status = result.protected.ok ? "passed" : "failed";
  if (!result.protected.ok) {
    protectedStep.detail = result.protected.error ?? result.protected.hits.map(hit => `${hit.path} (${hit.rule}: ${hit.reason})`).join("\n");
    return finish("failed");
  }
  publish();

  for (const definition of definitions) {
    const current = step(definition.id);
    current.status = "running"; publish();
    const begun = now();
    let failure: string | undefined;
    try {
      for (const { command, args } of definition.commands(base)) {
        const out = await exec(command, args, { cwd: worktree, timeoutMs: definition.timeoutMs });
        if (out.timedOut) { failure = `timed out after ${definition.timeoutMs}ms\n${tail(out.output)}`; break; }
        if (out.code !== 0) { failure = `exit ${out.code}\n${tail(out.output)}`; break; }
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    current.durationMs = now() - begun;
    current.status = failure === undefined ? "passed" : "failed";
    if (failure !== undefined) { current.detail = failure; return finish("failed"); }
    publish();
  }
  return finish("passed");
}
