import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNativeAgentLoop } from "./native-loop.js";
import { assertWorkspaceIdentity, captureWorkspaceIdentity } from "./workspace-identity.js";

const roots: string[] = [];
function repo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `0-identity-${name}-`));
  roots.push(root);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", `https://example.test/${name}.git`]);
  writeFileSync(join(root, `${name}.txt`), name);
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", name]);
  return root;
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("delegated Git workspace identity", () => {
  it("accepts repo B at an absolute path and rejects default repo A", () => {
    const a = repo("a");
    const b = repo("b");
    const identity = captureWorkspaceIdentity(b)!;
    expect(identity.origin).toBe("https://example.test/b.git");
    expect(() => assertWorkspaceIdentity(identity, b)).not.toThrow();
    expect(() => assertWorkspaceIdentity(identity, a)).toThrow("workspace_mismatch");
    expect(() => assertWorkspaceIdentity(identity, undefined)).toThrow("workspace_mismatch");
  });

  it("ignores ambient Git repository and config overrides pointing at repo A", () => {
    const a = repo("a"); const b = repo("b");
    const identity = captureWorkspaceIdentity(b)!;
    vi.stubEnv("GIT_DIR", join(a, ".git"));
    vi.stubEnv("GIT_WORK_TREE", a);
    vi.stubEnv("GIT_COMMON_DIR", join(a, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(a, ".git", "index"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(a, ".git", "objects"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "remote.origin.url");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://example.test/override.git");
    expect(captureWorkspaceIdentity(b)).toEqual(identity);
    expect(() => assertWorkspaceIdentity(identity, b)).not.toThrow();
    expect(() => assertWorkspaceIdentity(identity, a)).toThrow("workspace_mismatch");
  });

  it("does not identify a bare directory or unrelated configured worktree as the source repo", () => {
    const a = repo("a"); const b = repo("b");
    const bare = mkdtempSync(join(tmpdir(), "0-identity-bare-")); roots.push(bare);
    execFileSync("git", ["init", "--bare", "-q"], { cwd: bare });
    expect(captureWorkspaceIdentity(bare)).toBeUndefined();
    execFileSync("git", ["config", "core.worktree", a], { cwd: b });
    expect(captureWorkspaceIdentity(b)).toBeUndefined();
  });

  it("rejects a child startup mismatch before any model request", async () => {
    const a = repo("a"); const b = repo("b");
    const executeNative = vi.fn();
    await expect(runNativeAgentLoop({
      config: { role: "audit", systemPrompt: "review source", tools: [], maxTurns: 1,
        target: "fixture", scanId: "identity-startup", scopePath: a,
        workspaceIdentity: captureWorkspaceIdentity(b) },
      runtime: { type: "api", isAvailable: async () => true, executeNative },
      db: null,
    })).rejects.toThrow("workspace_mismatch");
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("rejects a remapped symlink to default repo A at the same supplied path", () => {
    const a = repo("a");
    const b = repo("b");
    const links = mkdtempSync(join(tmpdir(), "0-identity-links-")); roots.push(links);
    const target = join(links, "target");
    symlinkSync(b, target);
    const identity = captureWorkspaceIdentity(target)!;
    rmSync(target);
    symlinkSync(a, target);
    expect(() => assertWorkspaceIdentity(identity, target)).toThrow("workspace_mismatch");
  });

  it("rejects a changed pinned HEAD and an unavailable target", () => {
    const b = repo("b");
    const identity = captureWorkspaceIdentity(b)!;
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "changed"], { cwd: b });
    expect(() => assertWorkspaceIdentity(identity, b)).toThrow("workspace_mismatch");
    rmSync(b, { recursive: true });
    expect(() => assertWorkspaceIdentity(identity, b)).toThrow("workspace_mismatch");
  });

  it("preserves non-Git source directory delegation", () => {
    const root = mkdtempSync(join(tmpdir(), "0-identity-source-")); roots.push(root);
    expect(captureWorkspaceIdentity(root)).toBeUndefined();
  });
});
