// Database file location, reset/repair and open-time safety checks.
import { isBunRuntime, type ShimmedDatabase } from "./wasm-shim.js";
import { homeStateDir } from "../shared/index.js";
import { ensureDatabaseDirectory } from "./db-directory.js";
import { and, or } from "drizzle-orm";
import { join } from "node:path";
import { closeSync, existsSync, openSync, readSync, renameSync, rmSync } from "node:fs";


export const DEFAULT_DB_DIR = homeStateDir();

export const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "0.db");


export function resolveOsecDbPath(dbPath?: string): string {
  const configuredPath = process.env["ZERO_DB_PATH"]?.trim();
  return dbPath ?? (configuredPath ? configuredPath : DEFAULT_DB_PATH);
}


export function resetOsecDatabase(dbPath?: string): string {
  const path = resolveOsecDbPath(dbPath);

  ensureDatabaseDirectory(path);

  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
    }
  }

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
