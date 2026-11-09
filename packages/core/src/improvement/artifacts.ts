import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { assertPrivateStorage } from "./private-storage.js";
import { canonicalEvolutionJson } from "./config.js";

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function resolveEvolutionDirectoryPath(path: string): string {
  const requested = resolve(path);
  const root = parse(requested).root;
  let cursor = root;
  const components = requested.slice(root.length).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    cursor = join(cursor, components[index]!);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      return join(cursor, ...components.slice(index + 1));
    }
    if (stat.isSymbolicLink()) {
      // Darwin's system-owned root aliases are trusted; arbitrary ancestor
      // aliases, including aliases inside an operator's store, are not.
      const trustedTarget = process.platform === "darwin"
        ? ({ "/tmp": "/private/tmp", "/var": "/private/var", "/etc": "/private/etc" } as Record<string, string>)[cursor]
        : undefined;
      if (!trustedTarget || stat.uid !== 0 || realpathSync(cursor) !== trustedTarget || index === components.length - 1) {
        throw new Error(`unsafe evolution directory: ${cursor}`);
      }
      cursor = trustedTarget;
    } else if (!stat.isDirectory()) {
      throw new Error(`unsafe evolution directory: ${cursor}`);
    }
  }
  return cursor;
}

function inspectDirectories(path: string, create: boolean, checkPrivacy = true): string {
  if (!isAbsolute(path)) throw new Error("evolution storage paths must be absolute");
  const absolute = resolveEvolutionDirectoryPath(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (create) {
      try { mkdirSync(cursor, { mode: 0o700 }); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    }
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe evolution directory: ${cursor}`);
  }
  const leaf = lstatSync(absolute);
  if (checkPrivacy) assertPrivateStorage([{ path: absolute, stat: leaf }]);
  return absolute;
}

/** Create private storage directories without following symbolic links. */
export function ensureEvolutionDirectory(path: string): string {
  return inspectDirectories(path, true);
}

/** Read a bounded, owner-owned JSON record without following a symbolic link. */
export function readEvolutionArtifact(path: string): unknown {
  const directory = inspectDirectories(dirname(path), false, false);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`unsafe evolution artifact: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES || stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new Error(`unsafe evolution artifact: ${path}`);
    }
    try { assertPrivateStorage([{ path: directory, stat: lstatSync(directory) }, { path, stat }]); }
    catch (error) {
      throw new Error(`unsafe evolution artifact: ${path}; ${error instanceof Error ? error.message : "storage privacy could not be verified"}`, { cause: error });
    }
    // The Windows ACL probe examines a pathname, not this open descriptor.
    // Reject replacement while the native probe was running.
    const verified = lstatSync(path);
    if (!verified.isFile() || verified.isSymbolicLink() || verified.dev !== stat.dev || verified.ino !== stat.ino) throw new Error(`unsafe evolution artifact: ${path}`);
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    canonicalEvolutionJson(value);
    return value;
  } finally { closeSync(fd); }
}

/** Atomically publish once. Replaying identical content is safe; replacement is forbidden. */
export function publishEvolutionArtifact(path: string, value: unknown): void {
  const content = canonicalEvolutionJson(value);
  if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) throw new Error("evolution artifact exceeds retention limit");
  const directory = ensureEvolutionDirectory(dirname(path));
  const temporary = join(directory, `.artifact-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, content, "utf8");
      fchmodSync(fd, 0o400);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (canonicalEvolutionJson(readEvolutionArtifact(path)) !== content) {
        throw new Error(`immutable evolution artifact collision: ${path}`);
      }
    }
    // Windows does not support opening/fsyncing directory descriptors.
    if (process.platform !== "win32") {
      const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } finally { unlinkSync(temporary); }
}
