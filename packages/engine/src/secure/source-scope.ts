import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** Whole-repository is the legacy default; narrowing is explicit and durable. */
export function normalizeSourcePath(value?: string): string {
  if (value === undefined || value === ".") return ".";
  if (!value || value.length > 500 || isAbsolute(value) || /[\\\x00-\x1f]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || part === ".git" || part === ".0")) {
    throw new Error("Scan folder must be a relative repository directory without traversal.");
  }
  return value;
}

export function resolveSourceScope(repoRoot: string, value?: string): string {
  const sourcePath = normalizeSourcePath(value);
  const root = realpathSync(repoRoot);
  let current = root;
  if (sourcePath !== ".") for (const part of sourcePath.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Scan folder must be a regular repository directory, not a link.");
  }
  const actual = realpathSync(current);
  const path = relative(root, actual);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("Scan folder escapes the repository.");
  return actual;
}

/** Apply to reads and every patch operation before touching a disposable checkout. */
export function assertSourceScopePath(path: string, value?: string): void {
  const sourcePath = normalizeSourcePath(value);
  if (!path || isAbsolute(path) || /[\\\x00-\x1f]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git" || part === ".0")
    || (sourcePath !== "." && !path.startsWith(`${sourcePath}/`))) {
    throw new Error("File is outside the approved scan folder.");
  }
}
