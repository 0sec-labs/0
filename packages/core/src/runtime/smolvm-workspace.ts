import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SmolvmWorkspaceLimits { maxBytes: number; maxFiles: number; }
export interface SmolvmWorkspaceFile { path: string; bytes: number; digest: string; }
export interface SmolvmWorkspaceManifest {
  files: SmolvmWorkspaceFile[];
  bytes: number;
  /** Dependency caches, Git metadata and private operator state are not a source snapshot. */
  excludedDirectories: readonly string[];
}
export const DEFAULT_SMOLVM_WORKSPACE_LIMITS: Readonly<SmolvmWorkspaceLimits> = Object.freeze({ maxBytes: 256 * 1024 * 1024, maxFiles: 16384 });
const EXCLUDED = [".git", "node_modules", ".0", ".ssh", ".codex", ".docker", ".config", "Library"] as const;

function limits(input: Partial<SmolvmWorkspaceLimits> = {}): SmolvmWorkspaceLimits {
  const value = { ...DEFAULT_SMOLVM_WORKSPACE_LIMITS, ...input };
  for (const key of ["maxBytes", "maxFiles"] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > DEFAULT_SMOLVM_WORKSPACE_LIMITS[key]) throw new Error(`Invalid workbench snapshot limit: ${key}`);
  }
  return value;
}
function contained(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
async function privateEmptyDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || /[:\0]/.test(path)) throw new Error("Snapshot destination requires an absolute directory");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || resolve(path) !== await realpath(path) || (await readdir(path)).length) throw new Error("Snapshot destination must be empty, private and without symlink ancestors");
}

/** Copy bounded source bytes (including in-root file link targets) into a private run, never grant the live tree RW. */
export async function snapshotSmolvmWorkspace(source: string, destination: string, input: Partial<SmolvmWorkspaceLimits> = {}, signal?: AbortSignal, excludePrivate = true, allowSourceFileLinks = true): Promise<SmolvmWorkspaceManifest> {
  const cap = limits(input);
  const root = await realpath(source);
  if (!(await lstat(root)).isDirectory()) throw new Error("Snapshot source must be a directory");
  if (contained(destination, root) || contained(root, destination)) throw new Error("Snapshot source and destination must not overlap");
  await privateEmptyDirectory(destination);
  const result: SmolvmWorkspaceManifest = { files: [], bytes: 0, excludedDirectories: excludePrivate ? EXCLUDED : [] };
  let entries = 0;
  async function walk(directory: string): Promise<void> {
    signal?.throwIfAborted();
    const names = await readdir(directory);
    if ((entries += names.length) > cap.maxFiles * 4) throw new Error("Workbench snapshot contains too many filesystem entries");
    for (const name of names.sort()) {
      signal?.throwIfAborted();
      const path = join(directory, name), suffix = relative(root, path);
      if (/[\x00-\x1f\x7f\\]/.test(suffix) || !contained(path, root)) throw new Error("Invalid snapshot path");
      const entry = await lstat(path);
      let before = entry, readPath = path;
      if (excludePrivate && (EXCLUDED as readonly string[]).includes(name) && (before.isDirectory() || before.isFile())) continue;
      if (before.isDirectory()) { await mkdir(join(destination, suffix), { mode: 0o700 }); await walk(path); continue; }
      if (entry.isSymbolicLink() && allowSourceFileLinks) {
        readPath = await realpath(path);
        if (!contained(readPath, root) || (excludePrivate && relative(root, readPath).split(sep).some(part => (EXCLUDED as readonly string[]).includes(part)))) throw new Error("Workbench snapshot rejects links outside granted source files");
        before = await lstat(readPath);
      }
      if (!before.isFile() || before.nlink !== 1) throw new Error("Workbench snapshot rejects links and special files");
      if (result.files.length >= cap.maxFiles || result.bytes + before.size > cap.maxBytes) throw new Error(`Workbench snapshot exceeds its file or byte limit at ${suffix}: ${result.files.length + 1}/${cap.maxFiles} files, ${result.bytes + before.size}/${cap.maxBytes} bytes`);
      async function verifyPath(): Promise<void> {
        if (await realpath(readPath) !== resolve(readPath) || await realpath(path) !== readPath || await realpath(dirname(path)) !== resolve(dirname(path))) throw new Error("Snapshot file ancestors changed or traverse symlinks");
        const target = await lstat(readPath);
        if (!target.isFile() || target.nlink !== 1 || target.dev !== before.dev || target.ino !== before.ino || target.size !== before.size || target.mtimeMs !== before.mtimeMs) throw new Error("Snapshot file changed during capture");
        if (entry.isSymbolicLink()) {
          const current = await lstat(path);
          if (!current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino || current.mtimeMs !== entry.mtimeMs) throw new Error("Snapshot link changed during capture");
        }
      }
      await verifyPath();
      const fd = await open(readPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const observed = await fd.stat();
        if (!observed.isFile() || observed.nlink !== 1 || observed.dev !== before.dev || observed.ino !== before.ino || observed.size !== before.size) throw new Error("Snapshot file changed during capture");
        bytes = Buffer.alloc(observed.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const read = await fd.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new Error("Snapshot file changed during read");
          offset += read.bytesRead;
        }
        const after = await fd.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Snapshot file changed during read");
        await verifyPath();
      } finally { await fd.close(); }
      await writeFile(join(destination, suffix), bytes, { flag: "wx", mode: (before.mode & 0o111) ? 0o700 : 0o600 });
      result.bytes += bytes.length;
      result.files.push({ path: suffix.split(sep).join("/"), bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
    }
  }
  try { await walk(root); return result; }
  catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

/** Publish only after VM and sibling teardown; never apply guest changes to source. */
export async function exportSmolvmWorkbenchArtifacts(workspace: string, state: string, destination: string, input: Partial<SmolvmWorkspaceLimits> = {}): Promise<{ workspace: SmolvmWorkspaceManifest; state: SmolvmWorkspaceManifest }> {
  await privateEmptyDirectory(destination);
  const staging = join(destination, `.export-${randomBytes(8).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const workspaceManifest = await snapshotSmolvmWorkspace(workspace, join(staging, "workspace"), input, undefined, true, false);
    const cap = limits(input);
    const stateManifest = await snapshotSmolvmWorkspace(state, join(staging, "state"), {
      maxBytes: Math.max(1, cap.maxBytes - workspaceManifest.bytes), maxFiles: Math.max(1, cap.maxFiles - workspaceManifest.files.length),
    }, undefined, false, false);
    if (workspaceManifest.bytes + stateManifest.bytes > cap.maxBytes || workspaceManifest.files.length + stateManifest.files.length > cap.maxFiles) throw new Error("Workbench artifacts exceed the aggregate snapshot limit");
    await writeFile(join(staging, "manifest.json"), JSON.stringify({ schemaVersion: 1, workspace: workspaceManifest, state: stateManifest }), { flag: "wx", mode: 0o600 });
    await rename(staging, join(destination, "artifacts"));
    return { workspace: workspaceManifest, state: stateManifest };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
