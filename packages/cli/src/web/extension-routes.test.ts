import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService } from "@0/engine";
import { handleExtensionRequest } from "./extension-routes.js";
import { describeConsoleAudit } from "./audit.js";
import { privilegedRouteDenial } from "./privileged-routes.js";

const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const skill = (name: string) => `---\nname: ${name}\ndescription: Skill ${name}\n---\n\nDo it.\n`;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ext-route-home-")); const repo = mkdtempSync(join(tmpdir(), "ext-route-repo-")); dirs.push(home, repo);
  git(repo, "init", "-q", "-b", "main");
  const commit = (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), c); } git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c"); return git(repo, "rev-parse", "HEAD"); };
  const v1 = commit({ "extension.json": JSON.stringify({ name: "demo", version: "1.0.0", description: "Demo" }), "skills/a/SKILL.md": skill("a") });
  return { home, repo, v1, commit, svc: createExtensionService({ home }) };
}
const call = (svc: ReturnType<typeof createExtensionService>, method: string, path: string, body?: unknown) => handleExtensionRequest(svc, path, method, body);

describe("extension routes", () => {
  it("tells the page whether a scope is defined: none, a project scope file, or a Sentinel scope", async () => {
    const { svc } = fixture();
    const project = mkdtempSync(join(tmpdir(), "ext-route-project-")); dirs.push(project);
    const overview = async (query: string, signals?: () => { agentScopes: number }) =>
      (await handleExtensionRequest(svc, "extensions", "GET", {}, new URLSearchParams(query), signals))!.data as { scopeDefined: boolean };
    expect((await overview(`project=${encodeURIComponent(project)}`)).scopeDefined).toBe(false);
    expect((await overview("", () => ({ agentScopes: 0 }))).scopeDefined).toBe(false);
    expect((await overview("", () => ({ agentScopes: 1 }))).scopeDefined).toBe(true);
    writeFileSync(join(project, "scope.json"), JSON.stringify({ in_scope: ["app.example.com"] }));
    expect((await overview(`project=${encodeURIComponent(project)}`)).scopeDefined).toBe(true);
  });

  it("adds a typed MCP server as a local extension through the same prompt and exact-revision confirm", async () => {
    const { svc } = fixture();
    const mcp = { name: "docs", command: "npx", args: ["-y", "docs-mcp"] };
    const preview = await call(svc, "POST", "extensions/preview", { mcp });
    expect(preview?.status).toBe(200);
    const prompt = (preview!.data as { prompt: { revision: string; canDo: string[] } }).prompt;
    expect(prompt.revision).toMatch(/^local-/); expect(prompt.canDo.join(" ")).toContain("docs");
    expect(svc.list().rows.some(r => r.name === "docs")).toBe(false);
    expect((await call(svc, "POST", "extensions/install", { mcp: { ...mcp, args: ["evil"] }, approvedRevision: prompt.revision, confirm: true }))?.status).toBe(409);
    expect((await call(svc, "POST", "extensions/install", { mcp: { name: "x", url: "http://insecure" }, approvedRevision: prompt.revision, confirm: true }))?.status).toBe(400);
    expect((await call(svc, "POST", "extensions/install", { mcp, approvedRevision: prompt.revision, confirm: true }))?.status).toBe(201);
    expect(svc.list().rows.find(r => r.name === "docs")).toBeTruthy();
  });

  it("previews without installing, then installs only the exact reviewed revision after an explicit confirm", async () => {
    const { svc, repo, v1 } = fixture();
    const preview = await call(svc, "POST", "extensions/preview", { source: `${repo}@${v1}` });
    expect(preview?.status).toBe(200);
    const prompt = (preview!.data as { prompt: { revision: string; repoAtCommit: string; canDo: string[] } }).prompt;
    expect(prompt.revision).toBe(v1); expect(prompt.repoAtCommit).toContain(v1);
    expect(svc.list().rows.some(r => r.name === "demo")).toBe(false);
    expect((await call(svc, "POST", "extensions/install", { source: `${repo}@${v1}`, approvedRevision: v1 }))?.status).toBe(400); // confirm missing
    expect((await call(svc, "POST", "extensions/install", { source: `${repo}@${v1}`, approvedRevision: "0".repeat(40), confirm: true }))?.status).toBe(409);
    expect(svc.list().rows.some(r => r.name === "demo")).toBe(false);
    const done = await call(svc, "POST", "extensions/install", { source: `${repo}@${v1}`, approvedRevision: v1, confirm: true });
    expect(done?.status).toBe(201);
    const overview = (await call(svc, "GET", "extensions"))!.data as { rows: Array<{ name: string; status: string; skills: string[]; sourceLabel: string }> };
    expect(overview.rows.find(r => r.name === "demo")).toMatchObject({ status: "disabled", skills: ["a"] });
    expect(overview.rows.some(r => r.name === "scope" && r !== undefined)).toBe(true);
  });

  it("a local folder that changed after review is refused (its revision is its content hash)", async () => {
    const { svc, repo, commit } = fixture();
    const preview = await call(svc, "POST", "extensions/preview", { source: repo });
    const reviewed = (preview!.data as { prompt: { revision: string } }).prompt.revision; expect(reviewed).toMatch(/^local-/);
    commit({ "extra.txt": "x" });
    const r = await call(svc, "POST", "extensions/install", { source: repo, approvedRevision: reviewed, confirm: true });
    expect(r!.status).toBe(409); expect(svc.list().rows.some(x => x.name === "demo")).toBe(false);
  });

  it("enable needs approval for unapproved revisions; disable of a built-in needs confirmation; update shows the diff", async () => {
    const { svc, repo, v1, commit } = fixture();
    await call(svc, "POST", "extensions/install", { source: `${repo}@${v1}`, approvedRevision: v1, confirm: true });
    expect((await call(svc, "POST", "extensions/enable", { name: "demo" }))?.status).toBe(200);
    expect((await call(svc, "POST", "extensions/disable", { name: "scope" }))?.status).toBe(409);
    const v2 = commit({ "scripts/go.sh": "#!/bin/sh\necho hi\n" });
    const upd = await call(svc, "POST", "extensions/update/preview", { name: "demo", to: v2 });
    const p = (upd!.data as { prompt: { kind: string; diff: { added: string[] } } }).prompt;
    expect(p.kind).toBe("update"); expect(p.diff.added).toContain("scripts/go.sh");
    expect((await call(svc, "POST", "extensions/update", { name: "demo", to: v2, approvedRevision: v1, confirm: true }))?.status).toBe(409);
    expect((await call(svc, "POST", "extensions/update", { name: "demo", to: v2, approvedRevision: v2, confirm: true }))?.status).toBe(200);
    expect((await call(svc, "POST", "extensions/remove", { name: "demo" }))?.status).toBe(400); // confirm missing
    expect((await call(svc, "POST", "extensions/remove", { name: "demo", confirm: true }))?.status).toBe(200);
  });

  it("rejects bad input and unknown routes, and ignores non-extension paths", async () => {
    const { svc } = fixture();
    expect((await call(svc, "POST", "extensions/preview", { source: "git@github.com:o/r.git" }))?.status).toBe(400);
    expect((await call(svc, "POST", "extensions/preview", { source: "x", extra: 1 }))?.status).toBe(400);
    expect((await call(svc, "POST", "extensions/nope", {}))?.status).toBe(404);
    expect((await call(svc, "DELETE", "extensions"))?.status).toBe(405);
    expect(await call(svc, "GET", "skills")).toBeNull();
  });
});

describe("authority and audit", () => {
  const browser = { engineRequest: false, teamEnabled: false }; const engine = { engineRequest: true, teamEnabled: false }; const member = { engineRequest: false, teamEnabled: true, role: "member" };
  it.each(["extensions/preview", "extensions/install", "extensions/update/preview", "extensions/update", "extensions/enable", "extensions/disable", "extensions/remove"])("%s is browser-only and owner-only", path => {
    expect(privilegedRouteDenial(`/api/console/${path}`, "POST", engine)?.data.code).toBe("browser_only");
    expect(privilegedRouteDenial(`/api/console/${path}`, "POST", member)?.data.code).toBe("owner_required");
    expect(privilegedRouteDenial(`/api/console/${path}`, "POST", browser)).toBeNull();
  });
  it("reading the list is open to the engine", () => { expect(privilegedRouteDenial("/api/console/extensions", "GET", engine)).toBeNull(); });
  it("every mutating route produces an audit entry without secrets", () => {
    expect(describeConsoleAudit("extensions/install", "POST", { source: "o/r", approvedRevision: "a".repeat(40), confirm: true })).toMatchObject({ action: "extension.install", subject: "o/r", detail: { approved: true, version: "a".repeat(12) } });
    expect(describeConsoleAudit("extensions/enable", "POST", { name: "demo", approve: true })?.action).toBe("extension.enable");
    expect(describeConsoleAudit("extensions/remove", "POST", { name: "demo", confirm: true })?.action).toBe("extension.remove");
    expect(describeConsoleAudit("extensions/update/preview", "POST", { name: "demo" })?.action).toBe("extension.update.review");
    expect(describeConsoleAudit("extensions", "GET", undefined)).toBeNull();
  });
});
