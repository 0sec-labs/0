import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryContext } from "./context.js";
import { folderIdentity, normalizeRemote } from "./identity.js";
import { folderKey } from "./core.js";
import { createFileNoteStore } from "./store.js";

let root: string; let home: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "notes-git-"))); home = join(root, "home"); mkdirSync(home); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string, remote?: string): string {
  const dir = join(root, name); mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

describe("repository identity", () => {
  it("normalises equivalent remote URLs", () => {
    for (const url of ["git@github.com:Acme/App.git", "https://github.com/Acme/App", "https://user:tok@GitHub.com/Acme/App.git/", "ssh://git@github.com/Acme/App.git", "ssh://git@github.com:22/Acme/App"])
      expect(normalizeRemote(url)).toBe("github.com/Acme/App");
    expect(normalizeRemote("")).toBeUndefined();
  });
  it("gives clones, subfolders and linked worktrees of one repository the same identity", () => {
    const a = repo("a", "git@github.com:acme/app.git");
    const clone = repo("b", "https://github.com/acme/app");
    mkdirSync(join(a, "pkg"));
    const wt = join(root, "app-wt-feature");
    git(a, "worktree", "add", "-q", "-b", "feature", wt);
    const id = "git:github.com/acme/app";
    expect([folderIdentity(a), folderIdentity(clone), folderIdentity(join(a, "pkg")), folderIdentity(wt)]).toEqual([id, id, id, id]);
  });
  it("falls back to the real path without a remote or a repository", () => {
    const local = repo("local");
    const plain = join(root, "plain"); mkdirSync(plain);
    expect(folderIdentity(local)).toBe(local);
    expect(folderIdentity(plain)).toBe(plain);
    expect(folderIdentity(join(root, "missing"))).toBe(join(root, "missing"));
  });
  it("shares notes between a repository, its worktree and a clone, without writing into any of them", () => {
    const a = repo("a", "git@github.com:acme/app.git");
    const clone = repo("b", "https://github.com/acme/app.git");
    const wt = join(root, "app-wt-x"); git(a, "worktree", "add", "-q", "-b", "x", wt);
    const store = createFileNoteStore({ home });
    store.add({ text: "Tests run with pnpm test", folder: a, kind: "command", source: "user" });
    expect(store.list({ folder: wt }).map(n => n.text)).toEqual(["Tests run with pnpm test"]);
    expect(store.list({ folder: clone })).toHaveLength(1);
    expect(memoryContext(store, wt).text).toContain("pnpm test");
    expect(memoryContext(store, join(root, "unrelated")).text).not.toContain("pnpm test");
    expect(store.add({ text: "tests run with PNPM test", folder: wt, source: "user" }).id).toBe(store.list()[0]!.id);
    expect(store.list()).toHaveLength(1);
  });
  it("keeps reading folders stored under the older path hash and maps them to the repository", () => {
    const a = repo("a", "git@github.com:acme/app.git");
    const dir = join(home, ".0", "memory", folderKey(a)); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), `<!-- folder: ${a} -->\n# Memory for ${a}\n\n- Legacy note <!-- id=m_1e9ac700 source=you created=2026-01-01T00:00:00.000Z -->\n`);
    const wt = join(root, "app-wt-y"); git(a, "worktree", "add", "-q", "-b", "y", wt);
    const store = createFileNoteStore({ home });
    expect(store.list({ folder: a }).map(n => n.id)).toEqual(["m_1e9ac700"]);
    expect(store.list({ folder: wt }).map(n => n.id)).toEqual(["m_1e9ac700"]); // the older path-keyed notes reach the worktree too
    store.add({ text: "Newer note", folder: wt, source: "user" });
    expect(store.list({ folder: a })).toHaveLength(2);
    expect(store.edit("m_1e9ac700", "Legacy note, edited")?.text).toBe("Legacy note, edited");
    expect(store.remove("m_1e9ac700")).toBe(true);
    expect(store.list({ folder: a }).map(n => n.text)).toEqual(["Newer note"]);
    expect(store.clear(a)).toBe(1);
  });
});
