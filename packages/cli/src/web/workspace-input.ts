import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isDangerousLocalRoot } from "@0/engine";
import { classifyFolderError, permissionMessageFor, probeFolderReadable } from "./workspace-access.js";

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
  try { return statSync(directory).isDirectory() && !isDangerousLocalRoot(realpathSync.native(directory)); } catch { return false; }
}

/** Resolves operator input to a canonical project folder or throws a plain, actionable message. Synchronous checks only; see verifyWorkspaceReadable for the read probe. */
export function resolveWorkspaceInput(raw: string, base: string, home = homedir()): string {
  const value = normalizeWorkspaceInput(raw, home);
  if (!value) throw new WorkspaceInputError("Enter a folder path.");
  const typed = isAbsolute(value) ? value : resolve(base, value);
  let directory: string;
  // native realpath returns the folder's real case and unicode form on APFS, so every later comparison sees one spelling.
  try { directory = realpathSync.native(typed); }
  catch (error) {
    if (classifyFolderError(error) === "permission") throw new WorkspaceInputError(permissionMessageFor(resolve(typed), { error }));
    throw new WorkspaceInputError("That folder doesn't exist. Check the path, or choose a folder from the list.");
  }
  let isDirectory: boolean;
  try { isDirectory = statSync(directory).isDirectory(); }
  catch (error) { throw new WorkspaceInputError(permissionMessageFor(directory, { error })); }
  if (!isDirectory) throw new WorkspaceInputError("That path is a file. Choose the folder that contains it.");
  if (isDangerousLocalRoot(directory)) throw new WorkspaceInputError("Zero can't work in your whole home folder or the disk root. Choose a folder inside it, such as ~/Documents/my-project.");
  // stat succeeds on a folder we cannot read (macOS privacy protection), so check access the way the engine will use it.
  try { accessSync(directory, constants.R_OK | constants.X_OK); }
  catch (error) { throw new WorkspaceInputError(permissionMessageFor(directory, { error })); }
  return directory;
}

/**
 * Opens the folder like the engine's tools do (opendir plus first entry). A folder that is only slow (iCloud, network)
 * is accepted after the timeout instead of blocking the picker; a definite permission error is explained.
 */
export async function verifyWorkspaceReadable(directory: string, options: Parameters<typeof probeFolderReadable>[1] = {}): Promise<void> {
  try { await probeFolderReadable(directory, options); }
  catch (error) {
    const failure = classifyFolderError(error);
    if (failure === "permission") throw new WorkspaceInputError(permissionMessageFor(directory, { error }));
    if (failure === "missing") throw new WorkspaceInputError("That folder doesn't exist. Check the path, or choose a folder from the list.");
    if (failure === "other") throw new WorkspaceInputError("Zero couldn't read that folder. Check that it is available, or choose another folder.");
  }
}
