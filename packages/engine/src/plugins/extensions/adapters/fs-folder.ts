/** Read a folder from disk into the in-memory model, and write one back. Symbolic links and special files are refused. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIMITS, validateFolder, type FolderFile } from "../core/files.js";
import { err, ok, type Result } from "../core/result.js";

export function readFolder(root: string): Result<FolderFile[]> {
  const files: FolderFile[] = []; let bytes = 0; let failure: string | null = null;
  const visit = (dir: string, prefix: string, depth: number) => {
    if (failure) return;
    if (depth > LIMITS.depth) { failure = "Folder is nested too deeply."; return; }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (failure) return;
      if (!prefix && entry.name === ".git") continue;
      const rel = prefix + entry.name; const full = join(dir, entry.name); const stat = lstatSync(full);
      if (stat.isSymbolicLink()) { failure = `Folders cannot contain symbolic links (${rel}).`; return; }
      if (stat.isDirectory()) { visit(full, `${rel}/`, depth + 1); continue; }
      if (!stat.isFile()) { failure = `Only regular files are allowed (${rel}).`; return; }
      if (files.length >= LIMITS.files || bytes + stat.size > LIMITS.bytes) { failure = "Folder is too large."; return; }
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const s = fstatSync(fd); const data = readFileSync(fd); bytes += data.length; files.push({ path: rel, size: data.length, executable: (s.mode & 0o111) !== 0, bytes: data }); }
      finally { closeSync(fd); }
    }
  };
  try { visit(root, "", 0); } catch (error) { return err("io", `Cannot read ${root}: ${(error as Error).message}`); }
  if (failure) return err("unsafe_content", failure);
  const valid = validateFolder(files);
  return valid.ok ? ok(files) : valid;
}

export function writeFolder(root: string, files: readonly FolderFile[]): void {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.bytes, { mode: file.executable ? 0o700 : 0o600, flag: "wx" });
  }
}
