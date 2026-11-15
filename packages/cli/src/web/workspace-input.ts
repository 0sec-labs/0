import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isDangerousLocalRoot } from "@0/engine";

export class WorkspaceInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Expands a leading `~`, strips wrapping quotes and `file://`, so typed paths behave like a shell would. */
export function normalizeWorkspaceInput(raw: string, home = homedir()): string {
  let value = raw.trim();
  if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1).trim();
  if (value.startsWith("file://")) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { /* keep the typed text */ }
  }
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return value;
}

export function isUsableWorkspace(directory: string): boolean {
  try { return statSync(directory).isDirectory() && !isDangerousLocalRoot(realpathSync(directory)); } catch { return false; }
}

/** Resolves operator input to a canonical project folder or throws a plain, actionable message. */
export function resolveWorkspaceInput(raw: string, base: string, home = homedir()): string {
  const value = normalizeWorkspaceInput(raw, home);
  if (!value) throw new WorkspaceInputError("Enter a folder path.");
  let directory: string;
  try { directory = realpathSync(isAbsolute(value) ? value : resolve(base, value)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new WorkspaceInputError("Zero doesn't have permission to open that folder. On macOS, allow your terminal or Zero under System Settings, Privacy & Security, Files and Folders, then try again.");
    throw new WorkspaceInputError("That folder doesn't exist. Check the path, or choose a folder from the list.");
  }
  let isDirectory: boolean;
  try { isDirectory = statSync(directory).isDirectory(); }
  catch { throw new WorkspaceInputError("Zero doesn't have permission to open that folder. On macOS, allow your terminal or Zero under System Settings, Privacy & Security, Files and Folders, then try again."); }
  if (!isDirectory) throw new WorkspaceInputError("That path is a file. Choose the folder that contains it.");
  if (isDangerousLocalRoot(directory)) throw new WorkspaceInputError("Zero can't work in your whole home folder or the disk root. Choose a folder inside it, such as ~/Documents/my-project.");
  return directory;
}
