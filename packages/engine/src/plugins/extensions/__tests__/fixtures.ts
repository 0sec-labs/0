import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ext-${prefix}-`));
export const cleanup = (...dirs: string[]) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };

const GIT_ENV = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

export function writeTree(root: string, files: Record<string, string | { content: string; exec?: boolean }>): void {
  for (const [path, value] of Object.entries(files)) {
    const full = join(root, path); mkdirSync(dirname(full), { recursive: true });
    const spec = typeof value === "string" ? { content: value } : value;
    writeFileSync(full, spec.content); if (spec.exec) chmodSync(full, 0o755);
  }
}

/** A real git repo with one commit per entry of `commits`; each entry replaces the working tree (null deletes a path). Returns the SHAs. */
export function makeRepo(commits: Array<Record<string, string | { content: string; exec?: boolean } | null>>): { dir: string; shas: string[] } {
  const dir = tmp("repo"); git(dir, "init", "-q", "-b", "main"); const shas: string[] = [];
  for (const [i, files] of commits.entries()) {
    for (const [path, value] of Object.entries(files)) {
      if (value === null) { rmSync(join(dir, path), { force: true }); continue; }
      writeTree(dir, { [path]: value });
    }
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", `c${i + 1}`); shas.push(git(dir, "rev-parse", "HEAD"));
  }
  return { dir, shas };
}

export const MCP_JSON = JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"], env: { DOCS_TOKEN: "x" } } } });
export const SKILL = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}\n---\n\nDo the thing.\n`;

import { approvalFor } from "../installer.js";
import type { ExtensionService } from "../index.js";
import type { Approval, PreparedInstall } from "../ports.js";
/** Commit with the approval an operator would give for exactly this prompt; `over` overrides fields to test mismatches. */
export const approve = (svc: ExtensionService, prepared: PreparedInstall, over: Partial<Approval> = {}) => svc.installer.commit(prepared, { ...approvalFor(prepared), ...over });
