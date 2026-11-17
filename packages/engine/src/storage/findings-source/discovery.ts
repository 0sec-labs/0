import { statSync } from "node:fs";
import { resolve } from "node:path";
import { listOsecRunDatabasePaths } from "../run-storage.js";

export const DEFAULT_MAX_RUN_DATABASES = 300;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 ** 3;

export interface DiscoveryOptions { homeDir?: string; /** Replaces how run database files are listed. */ listPaths?: () => string[]; maxDatabases?: number; maxTotalBytes?: number }
export interface DiscoveredRuns { paths: string[]; skipped: number }

/** Per-run databases, newest first, bounded by count and total size. Older runs beyond the bound are skipped. */
export function discoverRunDatabases(options: DiscoveryOptions = {}): DiscoveredRuns {
  const maxDatabases = options.maxDatabases ?? DEFAULT_MAX_RUN_DATABASES;
  const maxBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const entries: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const path of (options.listPaths ?? (() => listOsecRunDatabasePaths(options.homeDir)))()) {
    try { const stat = statSync(path); entries.push({ path: resolve(path), mtimeMs: stat.mtimeMs, size: stat.size }); } catch { /* Removed while listing. */ }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const paths: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (paths.length >= maxDatabases || bytes + entry.size > maxBytes) break;
    paths.push(entry.path);
    bytes += entry.size;
  }
  return { paths, skipped: entries.length - paths.length };
}
