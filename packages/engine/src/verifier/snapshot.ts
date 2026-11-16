/**
 * Snapshots of a Git working tree for the verifier. Only Git plumbing runs on
 * the host (no hooks, no repo code); the files are copied, never executed.
 */
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exec } from "./process.js";

export interface Snapshot { dir: string; cleanup(): void }

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await exec("git", args, { cwd, timeoutMs: 60_000, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0" } });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed`);
  return r.output;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, timeoutMs: 10_000 });
  return r.code === 0 && r.output.trim() === "true";
}

const scratch = () => mkdtempSync(join(tmpdir(), "0-verify-snap-"));
const handle = (dir: string): Snapshot => ({ dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) });

/** The working tree as it is now: tracked and untracked files that Git does not ignore. */
export async function snapshotWorktree(repo: string): Promise<Snapshot> {
  const root = resolve(repo);
  const listing = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const dir = scratch();
  for (const rel of listing.split("\0").filter(Boolean)) {
    const from = join(root, rel);
    const to = join(dir, rel);
    let stat;
    try { stat = lstatSync(from); } catch { continue; } // deleted since indexed
    mkdirSync(dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (stat.isFile()) copyFileSync(from, to);
    else if (stat.isDirectory()) cpSync(from, to, { recursive: true, verbatimSymlinks: true }); // submodule path
  }
  return handle(dir);
}

/** The committed tree at HEAD, the "before" side of a baseline comparison. */
export async function snapshotHead(repo: string): Promise<Snapshot> {
  const root = resolve(repo);
  const dir = scratch();
  const index = join(scratch(), "index");
  try {
    await git(root, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
    await git(root, ["checkout-index", "-a", "-f", `--prefix=${dir}/`], { GIT_INDEX_FILE: index });
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { rmSync(dirname(index), { recursive: true, force: true }); }
  return handle(dir);
}
