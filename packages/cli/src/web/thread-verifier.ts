/**
 * Harness-side verifier gate for a Thread started with a skill that declares
 * `verify`. The model never calls this; the gateway does, after the model ends
 * its turn. Only built-in skills are runnable in this slice.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  OciRunner, gateDone, isGitRepo, loadSkillRegistry, runVerifier, snapshotHead, snapshotWorktree,
  type ContainerRunner, type VerifierResult, type VerifySpec,
} from "@0/engine";

const execFileAsync = promisify(execFile);

export interface ThreadVerifier { skillId: string; spec: VerifySpec; instructions: string; baseRev?: string; briefed?: boolean }

export interface ThreadVerification {
  line: string;
  /** True when the reply claimed the work was fixed or verified and the check did not pass. */
  claimBlocked: boolean;
  result: VerifierResult;
}

/** Resolve a built-in skill that declares a verifier. Throws a plain message otherwise. */
export function resolveThreadVerifier(id: string): ThreadVerifier {
  const skill = loadSkillRegistry().get(id.replace(/^builtin\//, ""));
  if (!skill) throw new Error(`Skill "${id}" was not found.`);
  if (!skill.verify) throw new Error(`Skill "${id}" does not declare a verifier.`);
  return { skillId: skill.id, spec: skill.verify, instructions: skill.content };
}

export async function captureBaseRev(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, timeout: 10_000 });
    return /^[0-9a-f]{40}$/.test(stdout.trim()) ? stdout.trim() : undefined;
  } catch { return undefined; }
}

const notRun = (verifier: ThreadVerifier, reason: string, detail: string): VerifierResult => ({
  schemaVersion: 1, status: "not-run", reason, command: verifier.spec.steps.map((s) => s.run).join(" && "), isolation: "container",
  durationMs: 0, logTail: detail, canary: "n/a", skillId: verifier.skillId,
});

/** Run the declared check on snapshots of the repo and gate the claim. Never throws. */
export async function verifyThreadTurn(input: { verifier: ThreadVerifier; repo: string; claim: string; runner?: ContainerRunner; signal?: AbortSignal }): Promise<{ message: string; verification: ThreadVerification }> {
  const { verifier, repo } = input;
  let result: VerifierResult;
  const cleanups: Array<() => void> = [];
  try {
    if (!(await isGitRepo(repo))) result = notRun(verifier, "not-a-git-repo", "");
    else {
      const after = await snapshotWorktree(repo); cleanups.push(after.cleanup);
      let beforeDir: string | undefined;
      if (verifier.spec.success.baseline && verifier.baseRev) { const before = await snapshotHead(repo, verifier.baseRev); cleanups.push(before.cleanup); beforeDir = before.dir; }
      result = await runVerifier({ spec: verifier.spec, afterDir: after.dir, ...(beforeDir ? { beforeDir } : {}), runner: input.runner ?? new OciRunner(), skillId: verifier.skillId, ...(input.signal ? { signal: input.signal } : {}) });
    }
  } catch (error) {
    result = { ...notRun(verifier, "infra-error", error instanceof Error ? error.message.slice(0, 200) : "unknown error"), status: "error" };
  } finally { for (const cleanup of cleanups) cleanup(); }
  const decision = gateDone({ declared: true, claim: input.claim, result });
  return { message: decision.message, verification: { line: decision.line!, claimBlocked: !decision.allowed, result } };
}
