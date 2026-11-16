import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, gitTreeHash, validateFolder, type FolderFile } from "../core/files.js";
import { sanitizeName } from "../core/manifest.js";
import { err, ok, type Result } from "../core/result.js";
import type { ExtensionSource, Snapshot } from "../ports.js";

const run = promisify(execFile);
export const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A git repository at one commit. Fetches only that commit and reads its files out of the object database:
 * no checkout, no hooks, no submodules, no LFS, nothing executed. The files must hash to the commit's tree.
 * `url` is https, or an absolute local path (`local: true`) which is how tests and local repos work.
 */
export class GitSource implements ExtensionSource {
  readonly label: string; readonly suggestedName: string;
  constructor(readonly url: string, readonly sha: string | null, readonly local: boolean) {
    this.label = url; this.suggestedName = sanitizeName(basename(url).replace(/\.git$/, ""));
  }
  get pinned() { return this.sha !== null; }

  async #git(args: string[], cwd: string, maxBuffer = 1024 * 1024): Promise<Buffer> {
    const protocols = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...(this.local ? ["-c", "protocol.file.allow=always"] : [])];
    const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...protocols, ...args], {
      cwd, encoding: "buffer", timeout: 120_000, maxBuffer,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    return stdout;
  }

  async fetch(): Promise<Result<Snapshot>> {
    const work = mkdtempSync(join(tmpdir(), "zero-extension-"));
    try { return await this.#fetchInto(work); }
    catch (error) { return err("fetch_failed", `Could not fetch ${this.label}: ${String((error as Error).message).split("\n")[0]}`); }
    finally { rmSync(work, { recursive: true, force: true }); }
  }

  async #fetchInto(work: string): Promise<Result<Snapshot>> {
    const g = (args: string[], max?: number) => this.#git(args, work, max);
    const helper = !this.local && /^https:\/\/github\.com\//.test(this.url) ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
    await g(["init", "-q"]);
    let sha = this.sha;
    if (sha) {
      try { await g([...helper, "fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", this.url, sha]); }
      catch { await g([...helper, "fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", this.url, "+refs/heads/*:refs/remotes/o/*", "+refs/tags/*:refs/tags/*"]); }
      try { await g(["cat-file", "-e", `${sha}^{commit}`]); } catch { return err("sha_not_found", `Commit ${sha} was not found in ${this.label}.`); }
    } else {
      await g([...helper, "fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", this.url, "HEAD"]);
      sha = (await g(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString("utf8").trim();
      if (!FULL_SHA.test(sha)) return err("fetch_failed", "Could not resolve a commit.");
    }
    const rows = (await g(["ls-tree", "-r", "-z", "--full-tree", sha], 16 * 1024 * 1024)).toString("utf8").split("\0").filter(Boolean);
    if (rows.length > LIMITS.files) return err("unsafe_content", `More than ${LIMITS.files} files.`);
    const entries: Array<{ path: string; oid: string; executable: boolean }> = [];
    for (const row of rows) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(row);
      if (!m) return err("fetch_failed", "Unreadable repository listing.");
      if (m[1] !== "100644" && m[1] !== "100755") return err("unsafe_content", `${m[4]} is a symbolic link or submodule; extensions may only contain regular files.`);
      entries.push({ path: m[4]!, oid: m[3]!, executable: m[1] === "100755" });
    }
    const files: FolderFile[] = []; let bytes = 0; const queue = [...entries];
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        if (bytes > LIMITS.bytes) return;
        const data = await g(["cat-file", "blob", e.oid], LIMITS.bytes + 1);
        bytes += data.length; files.push({ path: e.path, size: data.length, executable: e.executable, bytes: data });
      }
    }));
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    const valid = validateFolder(files); if (!valid.ok) return valid;
    const treeHash = gitTreeHash(files);
    const expected = (await g(["rev-parse", "--verify", `${sha}^{tree}`])).toString("utf8").trim();
    if (treeHash !== expected) return err("content_mismatch", "The fetched files do not hash to the commit's tree; refusing to install.");
    return ok({ revision: sha, files, treeHash, source: { type: "git", url: this.url } });
  }
}
