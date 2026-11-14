// Database file location, reset/repair and open-time safety checks.
import { isBunRuntime, type ShimmedDatabase } from "./wasm-shim.js";
import { homeStateDir } from "../shared/index.js";
import { ensureDatabaseDirectory } from "./db-directory.js";
import { and, or } from "drizzle-orm";
import { join } from "node:path";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, renameSync, rmSync, type Stats } from "node:fs";


export const DEFAULT_DB_DIR = homeStateDir();

export const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "0.db");


export function resolveOsecDbPath(dbPath?: string): string {
  const configuredPath = process.env["ZERO_DB_PATH"]?.trim();
  return dbPath ?? (configuredPath ? configuredPath : DEFAULT_DB_PATH);
}


/** A lock with no owner evidence is only treated as stale after this long. */
export const STALE_LOCK_MS = 5 * 60_000;

export interface ResetDatabaseDeps {
  /** Signal-0 probe; defaults to process.kill. Injectable for tests. */
  probe?: (pid: number) => void;
  now?: () => number;
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** PID recorded by a lock owner, if any (`<lock>/pid`, or a numeric lock file). */
function readLockOwnerPid(lockPath: string, stat: Stats): number | undefined {
  try {
    const file = stat.isDirectory() ? `${lockPath}/pid` : lockPath;
    if (stat.isDirectory() ? lstatSync(file).isSymbolicLink() : false) return undefined;
    const text = readFileSync(file, "utf8").trim();
    if (!/^\d{1,10}$/.test(text)) return undefined;
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

/** ESRCH means no such process; success and EPERM both mean it exists. */
function isProcessAlive(pid: number, probe: (pid: number) => void): boolean {
  try { probe(pid); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * Explicit, destructive reset of the database and its sidecars.
 *
 * Refuses to touch anything when the base path is a directory or other
 * non-file, or when a live process holds the `.lock`. Symlinks are removed as
 * links, never followed. `-journal` is removed only when no live holder exists.
 * Recursive removal applies solely to the `.lock` path (node-sqlite3-wasm uses a
 * lock directory), never to the database path.
 */
export function resetOsecDatabase(dbPath?: string, deps: ResetDatabaseDeps = {}): string {
  const path = resolveOsecDbPath(dbPath);
  const probe = deps.probe ?? ((pid: number) => { process.kill(pid, 0); });
  const now = deps.now ?? Date.now;

  ensureDatabaseDirectory(path);

  const baseStat = lstatOrNull(path);
  if (baseStat && !baseStat.isFile() && !baseStat.isSymbolicLink()) {
    throw new Error(`Refusing to reset ${path}: the database path is not a regular file (is it a directory?). Check ZERO_DB_PATH / --db-path.`);
  }

  const lockPath = `${path}.lock`;
  const lockStat = lstatOrNull(lockPath);
  if (lockStat && !lockStat.isSymbolicLink()) {
    const owner = readLockOwnerPid(lockPath, lockStat);
    const live = owner !== undefined
      ? isProcessAlive(owner, probe)
      : now() - lockStat.mtimeMs < STALE_LOCK_MS;
    if (live) {
      throw new Error(
        owner !== undefined
          ? `Refusing to reset ${path}: process ${owner} holds ${lockPath}. Stop it and retry.`
          : `Refusing to reset ${path}: ${lockPath} was modified recently and may be held by a running process. Stop other 0 processes and retry.`,
      );
    }
  }

  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    // force swallows ENOENT; non-recursive removes symlinks as links and fails on directories.
    rmSync(`${path}${suffix}`, { force: true });
  }
  if (lockStat) rmSync(lockPath, { force: true, recursive: true });

  return path;
}


export function timestampTag(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}


export function backupCorruptDatabase(path: string): string | null {
  if (!existsSync(path)) return null;

  const backupPath = `${path}.corrupt-${timestampTag()}`;
  renameSync(path, backupPath);

  for (const suffix of ["-wal", "-shm", ".lock"]) {
    const candidate = `${path}${suffix}`;
    if (!existsSync(candidate)) continue;
    try {
      renameSync(candidate, `${backupPath}${suffix}`);
    } catch {
      if (suffix === ".lock") {
        rmSync(candidate, { recursive: true, force: true });
      }
    }
  }

  return backupPath;
}


export function ensureDatabaseHealthy(sqlite: ShimmedDatabase): void {
  const rows = sqlite.prepare("PRAGMA quick_check(1)").all() as Array<Record<string, unknown>>;
  const first = rows[0] ? Object.values(rows[0])[0] : "ok";
  if (typeof first === "string" && first.toLowerCase() !== "ok") {
    throw new Error(first);
  }
}


/** Reject unsupported WAL files without editing their header or sidecars.
 * A WAL can contain committed data missing from the main file. Conversion must
 * be performed by a native SQLite connection after all other users stop.
 */
export function assertDatabaseEngineCompatibility(path: string): void {
  if (isBunRuntime() || path === ":memory:" || !existsSync(path)) return;
  const header = Buffer.alloc(20);
  const fd = openSync(path, "r");
  let bytesRead: number;
  try { bytesRead = readSync(fd, header, 0, header.length, 0); }
  finally { closeSync(fd); }
  if (bytesRead < header.length || header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0") return;
  if (header[18] !== 2 && header[19] !== 2) return;
  throw new Error(
    `Cannot open WAL-mode database at ${path} with the Node WASM SQLite engine. ` +
    "The database and WAL/SHM files have been preserved. Stop all database users, " +
    "back up the database together with its sidecars, then use a native SQLite " +
    "connection to checkpoint the WAL and set PRAGMA journal_mode=DELETE. " +
    "Do not delete WAL/SHM files or rewrite the database header. Alternatively, use the Bun native SQLite runtime.",
  );
}
