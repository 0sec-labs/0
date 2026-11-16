// Folder identity for notes: the git origin remote when the folder is in a repository, else
// the real path. Worktrees and clones of one repository therefore share their notes.
// Reads .git files directly; it never runs git and never writes.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const GIT_PREFIX = "git:";

/** `git@github.com:Org/Repo.git`, `https://user@GitHub.com/Org/Repo/` and `ssh://git@github.com/Org/Repo` all become `github.com/Org/Repo`. */
export function normalizeRemote(url: string): string | undefined {
  let rest = url.trim();
  if (!rest) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(rest);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) rest = `${scp[1]}/${scp[2]}`;
  else rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const host = rest.slice(0, slash).replace(/:\d+$/, "").toLowerCase();
  const path = rest.slice(slash + 1).replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  return host && path ? `${host}/${path}` : undefined;
}

function gitDirs(start: string): { worktreeDir: string; commonDir: string } | undefined {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    const dot = join(dir, ".git");
    if (existsSync(dot)) {
      try {
        if (statSync(dot).isDirectory()) return { worktreeDir: dot, commonDir: dot };
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
        if (!pointer) return undefined;
        const worktreeDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
        let commonDir = worktreeDir;
        try { const common = readFileSync(join(worktreeDir, "commondir"), "utf8").trim(); commonDir = isAbsolute(common) ? common : resolve(worktreeDir, common); } catch { /* not a linked worktree */ }
        return { worktreeDir, commonDir };
      } catch { return undefined; }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function originUrl(commonDir: string): string | undefined {
  try {
    const config = readFileSync(join(commonDir, "config"), "utf8");
    const section = /\[remote\s+"origin"\]([^[]*)/.exec(config)?.[1];
    return section ? /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() : undefined;
  } catch { return undefined; }
}

export function canonicalPath(folder: string): string {
  const abs = resolve(folder);
  try { return realpathSync(abs); } catch { return abs; }
}

/** `git:<host>/<path>` for a folder inside a repository with an origin remote; otherwise its real path. Identities pass through unchanged. */
export function folderIdentity(folder: string): string {
  if (folder.startsWith(GIT_PREFIX)) return folder;
  const path = canonicalPath(folder);
  const dirs = gitDirs(path);
  const remote = dirs ? originUrl(dirs.commonDir) : undefined;
  const normalized = remote ? normalizeRemote(remote) : undefined;
  return normalized ? `${GIT_PREFIX}${normalized}` : path;
}
