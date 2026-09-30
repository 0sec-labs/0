import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** Parent-observed identity, inherited unchanged by source-review descendants. */
export interface WorkspaceIdentity {
  readonly scopePath: string;
  readonly repositoryRoot: string;
  readonly origin: string | null;
  readonly head: string;
}

function git(cwd: string, args: string[]): string {
  // Probe the checkout at cwd, ignoring ambient repository/config overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync("git", args, {
    cwd, env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Non-Git source directories keep their existing delegation behavior. */
export function captureWorkspaceIdentity(scopePath?: string): WorkspaceIdentity | undefined {
  if (!scopePath) return undefined;
  try {
    const canonicalPath = realpathSync(scopePath);
    const repositoryRoot = realpathSync(git(canonicalPath, ["rev-parse", "--show-toplevel"]));
    const scopedRelativePath = relative(repositoryRoot, canonicalPath);
    if (isAbsolute(scopedRelativePath) || scopedRelativePath === ".." || scopedRelativePath.startsWith(`..${sep}`)) return undefined;
    const head = git(canonicalPath, ["rev-parse", "--verify", "HEAD"]);
    let origin: string | null = null;
    try { origin = git(canonicalPath, ["remote", "get-url", "origin"]); } catch { /* local-only repository */ }
    return Object.freeze({ scopePath: canonicalPath, repositoryRoot, origin, head });
  } catch {
    return undefined;
  }
}

/** Fail before model inference if a worker sees another repository or revision. */
export function assertWorkspaceIdentity(expected: WorkspaceIdentity, scopePath?: string): void {
  const observed = captureWorkspaceIdentity(scopePath);
  if (!observed || observed.scopePath !== expected.scopePath ||
      observed.repositoryRoot !== expected.repositoryRoot ||
      observed.origin !== expected.origin || observed.head !== expected.head) {
    // Remote URLs can embed credentials; never echo them into model-facing errors.
    const describe = (identity: WorkspaceIdentity | undefined) => identity
      ? JSON.stringify({ scopePath: identity.scopePath, repositoryRoot: identity.repositoryRoot, head: identity.head })
      : "unavailable";
    throw new Error(`workspace_mismatch: delegated source path, repository root, origin or HEAD differs from parent (expected ${describe(expected)}, observed ${describe(observed)})`);
  }
}
