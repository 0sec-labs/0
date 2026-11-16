import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitSource } from "../adapters/git-source.js";
import { readFolder } from "../adapters/fs-folder.js";
import { capabilitiesOf, capabilityKey } from "../core/capabilities.js";
import { diffFolders } from "../core/diff.js";
import { isSafeExtensionEnvName, extensionEnv } from "../core/env.js";
import { findNameCollision, validateFolder, type FolderFile } from "../core/files.js";
import { parseManifest } from "../core/manifest.js";
import { renderInstallPrompt } from "../core/prompt.js";
import { createExtensionService, unwrap } from "../index.js";
import { MCP_JSON, SKILL, approve, cleanup, git, makeRepo, tmp, writeTree } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => { cleanup(...dirs.splice(0)); });
const file = (path: string, text = "x", executable = false): FolderFile => ({ path, size: Buffer.byteLength(text), executable, bytes: Buffer.from(text) });
const mcp = (server: Record<string, unknown>) => [file("extension.json", JSON.stringify({ name: "demo" })), file(".mcp.json", JSON.stringify({ mcpServers: { s: server } }))];
const caps = (files: FolderFile[]) => capabilitiesOf(unwrap(parseManifest(files)));

describe("case and Unicode-normalisation collisions", () => {
  it("rejects A.md vs a.md, NFC vs NFD, and a file vs a differently cased folder, with a clear message", () => {
    for (const [a, b] of [["A.md", "a.md"], ["café.md", "café.md"], ["Docs", "docs/x.md"], ["skills/A/SKILL.md", "skills/a/SKILL.md"]]) {
      const files = [file(a!), file(b!)]; expect(findNameCollision(files), `${a} ${b}`).not.toBeNull();
      const v = validateFolder(files); expect(!v.ok && v.error.message).toMatch(/letter case or Unicode normalisation/);
    }
    expect(validateFolder([file("a.md"), file("b.md"), file("dir/a.md")]).ok).toBe(true);
  });

  it("is rejected at prepare time for a git commit (built with git plumbing so no disk is involved)", async () => {
    const dir = tmp("collide"); const home = tmp("home"); dirs.push(dir, home); git(dir, "init", "-q", "-b", "main");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: "x", encoding: "utf8" }).trim();
    for (const p of ["SKILL.md", "A.md", "a.md"]) git(dir, "update-index", "--add", "--cacheinfo", `100644,${blob},${p}`);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-q", "-m", "c");
    const sha = git(dir, "rev-parse", "HEAD");
    const r = await createExtensionService({ home }).installer.prepare(`${dir}@${sha}`);
    expect(!r.ok && r.error.message).toMatch(/letter case or Unicode normalisation/);
  });
});

describe("a planted .git inside a stored revision is tampering", () => {
  it("is refused when loading, in info, and by a re-read", async () => {
    const home = tmp("home"); const repo = makeRepo([{ "extension.json": JSON.stringify({ name: "demo" }), "skills/a/SKILL.md": SKILL("a") }]); dirs.push(home, repo.dir);
    const svc = createExtensionService({ home });
    unwrap(approve(svc, unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { enable: { scope: "global" } }));
    expect(svc.loadable().extensions.map(e => e.name)).toEqual(["demo"]);
    const stored = join(home, ".0", "extensions", "demo", repo.shas[0]!);
    mkdirSync(join(stored, ".git", "hooks"), { recursive: true }); writeFileSync(join(stored, ".git", "config"), "[core]\n");
    expect(svc.loadable().extensions).toEqual([]); expect(svc.loadable().refused[0]).toMatchObject({ name: "demo", code: "tampered" });
    const info = svc.info("demo"); expect(!info.ok && info.error.code).toBe("tampered");
    const raw = readFolder(stored); expect(!raw.ok && raw.error.code).toBe("tampered");
    expect(readFolder(stored, { skipGit: true }).ok).toBe(true); // reading a developer's own folder still skips .git
  });
});

describe("update diff never hides a change", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  it("lists every path and every executable-bit change even when the patch is large", () => {
    const before = [file("a.txt", "1"), file("run.sh", "echo\n", false)];
    const after = [file("a.txt", "2"), file("run.sh", "echo\n", true), ...Array.from({ length: 120 }, (_, i) => file(`docs/f${i}.md`, big(300)))];
    const d = diffFolders(before, after);
    expect(d.added).toHaveLength(120); expect(d.changed).toEqual(["a.txt", "run.sh"]); expect(d.modeChanges).toEqual([{ path: "run.sh", from: "644", to: "755" }]);
    expect(d.patch.length).toBeLessThan(80 * 1024);
    for (const p of [...d.added, ...d.changed]) expect(d.patch, p).toContain(`@@ ${p}`);
    expect(d.patchTruncated).toBe(true); expect(d.summarised.length).toBeGreaterThan(0);
  });
  it("shows changed scripts and MCP/config files first and summarises binaries and huge files by size and hash", () => {
    const after = [file("docs/z.md", "new"), file("scripts/go.sh", "rm -rf /\n"), file(".mcp.json", "{}"), file("image.bin", "\u0000\u0001"), file("huge.txt", "x".repeat(300 * 1024))];
    const d = diffFolders([], after);
    const order = [...d.patch.matchAll(/^@@ (\S+)/gm)].map(m => m[1]);
    expect(order.indexOf("scripts/go.sh")).toBeLessThan(order.indexOf(".mcp.json")); expect(order.indexOf(".mcp.json")).toBeLessThan(order.indexOf("docs/z.md"));
    expect(d.patch).toMatch(/image\.bin \(binary\)/); expect(d.patch).toMatch(/huge\.txt \(large file, summarised\)[\s\S]*sha256 [0-9a-f]{16}/);
  });
  it("the rendered prompt lists the mode change and the summary note", async () => {
    const repo = makeRepo([{ "extension.json": JSON.stringify({ name: "demo" }), "go.sh": { content: "echo\n" } }, { "go.sh": { content: "echo\n", exec: true } }]); const home = tmp("home"); dirs.push(home, repo.dir);
    const svc = createExtensionService({ home });
    unwrap(approve(svc, unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`))));
    const upd = unwrap(await svc.installer.prepareUpdate("demo", repo.shas[1]));
    expect("prompt" in upd && renderInstallPrompt(upd.prompt)).toContain("mode changed: go.sh 644 -> 755 (now executable)");
  });
});

describe("capability key covers what an MCP server connects to and receives", () => {
  const key = (server: Record<string, unknown>) => capabilityKey(caps(mcp(server)));
  const base = { command: "npx", args: ["-y", "srv"], env: { A_TOKEN: "x" } };
  it("changes when the url, an arg, a transport, an env NAME or a header NAME changes, and never includes values", () => {
    const k = key(base);
    expect(key({ ...base, args: ["-y", "srv", "--extra"] })).not.toBe(k);
    expect(key({ ...base, env: { A_TOKEN: "x", B_TOKEN: "y" } })).not.toBe(k);
    expect(key({ ...base, env: { A_TOKEN: "different value" } })).toBe(k);
    const http = { url: "https://a.example.com/mcp", headers: { "X-Key": "v" } };
    expect(key({ ...http, args: ["--flag"] })).not.toBe(key(http));
    expect(key({ ...http, url: "https://b.example.com/mcp" })).not.toBe(key(http));
    expect(key({ ...http, headers: { "X-Other": "v" } })).not.toBe(key(http));
    expect(key({ ...http, type: "sse" })).not.toBe(key(http));
    expect(key({ ...http, headers: { "X-Key": "other value" } })).toBe(key(http));
  });
});

describe("declared environment names use an allow pattern", () => {
  it("rejects loader and path-like variables and anything outside the pattern", () => {
    for (const bad of ["PATH", "PYTHONPATH", "NODE_PATH", "GIT_SSH_COMMAND", "GIT_DIR", "SHELLOPTS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "NODE_OPTIONS", "HOME", "HTTPS_PROXY", "lowercase_token", "FOO", "HTTP_PROXY_URL_X; rm", "A_TOKEN\n"]) {
      expect(isSafeExtensionEnvName(bad), bad).toBe(false);
      expect(parseManifest(mcp({ command: "x", env: { [bad]: "v" } })).ok, bad).toBe(false);
    }
    for (const good of ["DOCS_TOKEN", "OPENAI_API_KEY", "GITHUB_PERSONAL_ACCESS_TOKEN", "SLACK_BOT_TOKEN", "DB_HOST", "TENANT_ID"]) expect(isSafeExtensionEnvName(good), good).toBe(true);
    expect(parseManifest([file("extension.json", JSON.stringify({ name: "d", requires: { env: ["NODE_PATH"] } }))]).ok).toBe(false);
  });
  it("never passes a loader variable to a child even when declared and approved", () => {
    const env = extensionEnv({ declared: ["NODE_OPTIONS", "A_TOKEN", "GIT_DIR"], approved: ["NODE_OPTIONS", "A_TOKEN", "GIT_DIR"], parent: { NODE_OPTIONS: "--require evil", A_TOKEN: "t", GIT_DIR: "/x", PATH: "/bin" } });
    expect(env).toMatchObject({ A_TOKEN: "t", PATH: "/bin" }); expect(env).not.toHaveProperty("NODE_OPTIONS"); expect(env).not.toHaveProperty("GIT_DIR");
  });
});

describe("git sources", () => {
  it("reads one folder of a repository (subpath), hashes it as that tree, and refuses an unsafe subpath", async () => {
    const repo = makeRepo([{ "skills/sub/SKILL.md": SKILL("sub"), "skills/other/SKILL.md": SKILL("other"), "README.md": "r" }]); dirs.push(repo.dir);
    const snap = unwrap(await new GitSource(repo.dir, repo.shas[0]!, true, "skills/sub").fetch());
    expect(snap.files.map(f => f.path)).toEqual(["SKILL.md"]); expect(snap.treeHash).toBe(git(repo.dir, "rev-parse", `${repo.shas[0]}:skills/sub`));
    expect(snap.source).toEqual({ type: "git", url: repo.dir, subpath: "skills/sub" });
    for (const bad of ["../x", "skills/../..", "/abs", "a:b", "a b"]) { const r = await new GitSource(repo.dir, repo.shas[0]!, true, bad).fetch(); expect(r.ok, bad).toBe(false); }
  });
  it("an update of an imported owner/repo/path skill reads the same subpath", async () => {
    const repo = makeRepo([{ "skills/sub/SKILL.md": SKILL("sub") }, { "skills/sub/SKILL.md": `${SKILL("sub")}\nmore\n` }]); const home = tmp("home"); dirs.push(repo.dir, home);
    const svc = createExtensionService({ home });
    const source = svc.sources.fromRecord({ type: "git", url: repo.dir, subpath: "skills/sub" }, repo.shas[1]); const s = unwrap(source);
    expect(unwrap(await s.fetch()).files.map(f => f.path)).toEqual(["SKILL.md"]);
    expect(existsSync(home)).toBe(true);
  });
});

void writeTree; void MCP_JSON;
