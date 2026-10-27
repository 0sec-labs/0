import { closeSync, constants, fstatSync, openSync, readdirSync, read, readFile, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { resolveScopedPath } from "./scope-path.js";

const EXCLUDED_DIRECTORIES: Record<string, true> = {
  ".git": true,
  node_modules: true,
};
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCHED_FILES = 500;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_LINE_PREVIEW_LENGTH = 500;

interface ScopedFiles {
  root: string;
  files: string[];
  truncated: boolean;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, 1), maximum);
}

function collectScopedFiles(scopePath: string, requestedPath: string | undefined, limit: number): ScopedFiles {
  const root = resolveScopedPath(scopePath, ".");
  const start = resolveScopedPath(scopePath, requestedPath?.trim() || ".");
  const startStat = statSync(start);
  if (startStat.isFile()) {
    return { root, files: [start], truncated: false };
  }
  if (!startStat.isDirectory()) {
    throw new Error(`Path is not a file or directory: ${requestedPath ?? "."}`);
  }

  const files: string[] = [];
  const directories = [start];
  let truncated = false;

  while (directories.length > 0 && files.length < limit) {
    let entries: Dirent[];
    const directory = directories.pop()!;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;

      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!Object.hasOwn(EXCLUDED_DIRECTORIES, entry.name)) directories.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  if (directories.length > 0) truncated = true;
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  return { root, files, truncated };
}

async function readBoundedDescriptor(fd: number, maxBytes: number, signal?: AbortSignal): Promise<string> {
  // Reserve one sentinel byte so growth after fstat cannot bypass the search cap.
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    signal?.throwIfAborted();
    const bytes = await new Promise<number>((resolve, reject) => {
      read(fd, buffer, length, buffer.length - length, length, (error, bytesRead) => {
        if (error) reject(error);
        else resolve(bytesRead);
      });
    });
    signal?.throwIfAborted();
    if (bytes === 0) break;
    length += bytes;
    if (length > maxBytes) throw new Error("source file exceeds searched-byte limit");
  }
  return buffer.subarray(0, length).toString("utf8");
}

/** Resolve and open without yielding, then read the selected inode asynchronously.
 * A concurrent tool replacing the pathname or an ancestor cannot redirect the
 * pending read. Directory traversal remains synchronous for the same reason.
 */
export async function readScopedFile(
  scopePath: string | undefined,
  requestedPath: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const path = resolveScopedPath(scopePath, requestedPath);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (options.maxBytes !== undefined && fstatSync(fd).size > options.maxBytes) {
      throw new Error("source file exceeds searched-byte limit");
    }
    const content = options.maxBytes !== undefined
      ? await readBoundedDescriptor(fd, options.maxBytes, options.signal)
      : await new Promise<string>((resolve, reject) => {
        readFile(fd, { encoding: "utf8", signal: options.signal }, (error, value) => {
          if (error) reject(error);
          else resolve(value);
        });
      });
    options.signal?.throwIfAborted();
    return content;
  } finally { closeSync(fd); }
}

export function listScopedFiles(
  scopePath: string,
  args: Record<string, unknown>,
): { files: string[]; truncated: boolean } {
  const requestedPath = typeof args.path === "string" ? args.path : undefined;
  const limit = boundedInteger(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const collected = collectScopedFiles(scopePath, requestedPath, limit);
  return {
    files: collected.files.map((file) => relative(collected.root, file)),
    truncated: collected.truncated,
  };
}

export async function searchScopedFiles(
  scopePath: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  matches: Array<{ path: string; line: number; content: string }>;
  truncated: boolean;
  skippedFiles: number;
}> {
  signal?.throwIfAborted();
  const query = typeof args.query === "string" ? args.query : "";
  if (query.length === 0 || query.length > 256) {
    throw new Error("query must be between 1 and 256 characters");
  }

  const requestedPath = typeof args.path === "string" ? args.path : undefined;
  const maxResults = boundedInteger(args.max_results, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  const caseSensitive = args.case_sensitive === true;
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const collected = collectScopedFiles(scopePath, requestedPath, MAX_SEARCHED_FILES);
  const rootIdentity = statSync(collected.root, { bigint: true });
  // Keep the original authority across asynchronous content reads. Re-resolving
  // a replaced scope path must never silently authorize a different directory.
  const assertRootIdentity = (): void => {
    try {
      const currentRoot = resolveScopedPath(scopePath, ".");
      const currentIdentity = statSync(currentRoot, { bigint: true });
      if (currentRoot === collected.root
        && currentIdentity.dev === rootIdentity.dev
        && currentIdentity.ino === rootIdentity.ino) return;
    } catch { /* Missing or inaccessible authority also invalidates the search. */ }
    throw new Error("Allowed scope root changed during search");
  };
  const matches: Array<{ path: string; line: number; content: string }> = [];
  let skippedFiles = 0;

  for (const file of collected.files) {
    signal?.throwIfAborted();
    if (matches.length >= maxResults) break;

    let content: string;
    try {
      assertRootIdentity();
      content = await readScopedFile(scopePath, file, { signal, maxBytes: MAX_SEARCH_FILE_BYTES });
      assertRootIdentity();
    } catch {
      signal?.throwIfAborted();
      assertRootIdentity();
      skippedFiles += 1;
      continue;
    }
    if (content.includes("\0")) {
      skippedFiles += 1;
      continue;
    }

    const displayPath = relative(collected.root, file);
    for (const [index, line] of content.split("\n").entries()) {
      if (matches.length >= maxResults) break;
      const haystack = caseSensitive ? line : line.toLocaleLowerCase();
      if (haystack.includes(needle)) {
        matches.push({
          path: displayPath,
          line: index + 1,
          content: line.slice(0, MAX_LINE_PREVIEW_LENGTH),
        });
      }
    }
  }

  assertRootIdentity();
  return {
    matches,
    truncated: collected.truncated || matches.length >= maxResults,
    skippedFiles,
  };
}
