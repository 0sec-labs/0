import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_FOLDERS = 200;
const MAX_SCANNED_ENTRIES = 2_000;

export interface WorkspaceDirectoryListing {
  path: string;
  parentPath: string | null;
  homePath: string;
  entries: Array<{ name: string; path: string }>;
  truncated: boolean;
}

/** Owner-authorized host metadata only. Browsing never changes a session or reads file contents. */
export async function listWorkspaceDirectories(input?: unknown): Promise<WorkspaceDirectoryListing> {
  if (input !== undefined && (typeof input !== "string" || input.length > 4_096 || input.includes("\0"))) throw new Error("Enter a valid folder path.");
  const homePath = await realpath(homedir()).catch(() => resolve(homedir()));
  let path: string;
  try { path = await realpath(typeof input === "string" && input.trim() ? resolve(input.trim()) : homePath); }
  catch { throw new Error("That folder could not be found on this host."); }
  if (!(await stat(path)).isDirectory()) throw new Error("Choose a folder rather than a file.");
  let directory;
  try { directory = await opendir(path); }
  catch { throw new Error("This host cannot open that folder. Check its permissions or enter another path."); }
  const entries: WorkspaceDirectoryListing["entries"] = [];
  let scanned = 0;
  let truncated = false;
  for await (const entry of directory) {
    if (++scanned > MAX_SCANNED_ENTRIES) { truncated = true; break; }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const canonical = await realpath(join(path, entry.name));
      if (!(await stat(canonical)).isDirectory()) continue;
      if (entries.length >= MAX_FOLDERS) { truncated = true; break; }
      entries.push({ name: entry.name, path: canonical });
    } catch { /* Broken links and inaccessible entries cannot be selected. */ }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const parent = dirname(path);
  return { path, parentPath: parent === path ? null : parent, homePath, entries, truncated };
}
