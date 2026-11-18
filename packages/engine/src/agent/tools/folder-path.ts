/** Folder-confined path resolution shared by the file tools and the repair path. */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function canonicalizePath(path: string): string {
  const missingSegments: string[] = [];
  let existingPath = path;

  while (!pathEntryExists(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      throw new Error(`Path does not have an existing parent: ${path}`);
    }
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }

  // realpath resolves every symlink in the existing prefix. A dangling symlink
  // fails here instead of becoming a write-through escape for apply_patch.
  return resolve(realpathSync(existingPath), ...missingSegments);
}

export function isInFolder(folder: string, inputPath: string): boolean {
  const root = realpathSync(folder);
  const logicalCandidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(root, inputPath);

  let candidate: string;
  try {
    candidate = canonicalizePath(logicalCandidate);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
}

export function resolveFolderPath(folder: string | undefined, inputPath: string): string {
  if (!folder || !isInFolder(folder, inputPath)) {
    throw new Error(`Path escapes the folder: ${inputPath}`);
  }
  const root = realpathSync(folder);
  const logicalCandidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(root, inputPath);
  return canonicalizePath(logicalCandidate);
}
