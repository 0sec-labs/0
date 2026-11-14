import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-user engine state directory (`~/.0`): scan DB, journals, kernel and
 * intel caches, cloud credentials.
 */
export function homeStateDir(home: string = process.env.HOME || homedir()): string {
  return join(home, ".0");
}

/** Keep development Cloud credentials separate without changing other user state. */
export function cloudStateDir(home: string = process.env.HOME || homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const state = homeStateDir(home);
  return env["ZERO_DEV_SOURCE_ROOT"]?.trim() ? join(state, "dev") : state;
}

/**
 * Private mutable state for one engine execution. Every fresh run owns this
 * directory; only an explicit resume may reuse it.
 */
export function runStateDir(runId: string, home?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`Invalid 0 run id ${JSON.stringify(runId)}.`);
  }
  return join(homeStateDir(home), "runs", runId);
}

/** Path segments no scoped read/patch/scan may name: VCS metadata and engine state. */
export const PROTECTED_SEGMENTS: readonly string[] = [".git", ".0"];

/**
 * True for `.git` and `.0` (exact, case-sensitive: the check is lexical and
 * filesystem-agnostic; symlink and case-folding defence is the caller's
 * lstat/realpath walk).
 */
export function isProtectedSegment(segment: string): boolean {
  return PROTECTED_SEGMENTS.includes(segment);
}

/** Segment that is empty, `.`, `..` or protected: unusable in a scoped relative path. */
export function isUnsafeRelativeSegment(segment: string): boolean {
  return !segment || segment === "." || segment === ".." || isProtectedSegment(segment);
}

/** True when any `/`-separated segment of a caller-supplied relative path is unsafe. */
export function hasUnsafeRelativeSegment(relativePath: string): boolean {
  return relativePath.split("/").some(isUnsafeRelativeSegment);
}

/** True when any segment of an already-resolved relative path (split on `separator`) is protected. */
export function hasProtectedSegment(resolvedRelativePath: string, separator: string): boolean {
  return resolvedRelativePath.split(separator).some(isProtectedSegment);
}

/**
 * Directory for workdirs whose absolute path must stay short (macOS
 * sockaddr_un limits Unix socket paths to ~104 bytes, and `os.tmpdir()` is a
 * long /var/folders path there). `/tmp` on POSIX; `os.tmpdir()` elsewhere.
 */
export function shortTmpRoot(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? tmpdir() : "/tmp";
}

/**
 * Create a fresh private (0700) directory `<base>/<prefix>XXXXXX` and return
 * its path. `base` defaults to `os.tmpdir()`.
 */
export function tmpWorkdir(prefix: string, base: string = tmpdir()): Promise<string> {
  return mkdtemp(join(base, prefix));
}
