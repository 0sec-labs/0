import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function ensureDatabaseDirectory(path: string): void {
  if (path === ":memory:") return;
  const directory = dirname(resolve(path));
  // Bun on Windows can throw EEXIST for recursive mkdir("."). Avoid
  // recreating an existing parent and normalize relative database paths.
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
}
