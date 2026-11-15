import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_DETAIL_KEYS } from "@0/engine/storage";
import { CATALOG_LIMITS, SkillsCatalogService, handleSkillsCatalogRequest, licenceRule, loadCatalog, skillWarnings, titleCase, type CatalogFile, type GhRunner } from "./skills-catalog.js";
import { SkillsStore } from "./skills.js";
import { describeConsoleAudit } from "./audit.js";
import { privilegedRouteDenial } from "./privileged-routes.js";

vi.mock("@0/engine", async () => ({
  ...await import("@0/engine/dist/agent/skills/agent-skills.js"),
  loadSkillRegistry: (await import("@0/engine/dist/agent/skills/index.js")).loadSkillRegistry,
}));

const sha1 = (data: Buffer) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const COMMIT = "a".repeat(40);
const skillMd = (name = "demo-audit", body = "Audit the change.") => `---\nname: ${name}\ndescription: Audit demo changes.\n---\n\n${body}\n`;
interface Fake { license?: string | null; private?: boolean; files: Record<string, string | Buffer>; modes?: Record<string, string>; sizes?: Record<string, number>; corrupt?: string; truncated?: boolean }
/** An in-memory GitHub: repo metadata, one commit, a tree and blobs. No network. */
function fakeGh(repos: Record<string, Fake>): GhRunner & { calls: string[] } {
  const calls: string[] = [];
  const gh = (async (path: string) => {
    calls.push(path);
    const [, repoName] = /^repos\/([^/]+\/[^/?]+)/.exec(path) ?? [];
    const repo = repoName ? repos[repoName] : undefined;
    if (!repo) throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { stderr: "Not Found" });
    if (/^repos\/[^/]+\/[^/]+$/.test(path)) return JSON.stringify({ private: repo.private ?? false, default_branch: "main", license: repo.license === undefined ? { spdx_id: "MIT" } : repo.license ? { spdx_id: repo.license } : null });
    if (/\/commits\//.test(path)) return JSON.stringify({ sha: COMMIT });
    if (/\/git\/trees\//.test(path)) return JSON.stringify({ truncated: repo.truncated ?? false, tree: Object.entries(repo.files).map(([file, data]) => ({ path: file, mode: repo.modes?.[file] ?? "100644", type: "blob", sha: sha1(Buffer.from(data)), size: repo.sizes?.[file] ?? Buffer.from(data).length })) });
    const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(path)?.[1];
    const entry = Object.entries(repo.files).find(([, data]) => sha1(Buffer.from(data)) === blob);
    if (!entry) throw new Error("Not Found");
    const data = Buffer.from(entry[1]);
    return JSON.stringify({ encoding: "base64", content: (repo.corrupt === entry[0] ? Buffer.from("tampered") : data).toString("base64"), size: data.length });
  }) as GhRunner & { calls: string[] };
  gh.calls = calls; return gh;
}
const entry = { id: "acme~skills~demo-audit", name: "demo-audit", title: "Demo Audit", summary: "Audit demo changes.", repo: "acme/skills", path: "skills/demo-audit", ref: "main", commit: COMMIT, publisher: "acme", verified: true, stars: 10, pushedAt: "2026-11-01T00:00:00Z", licence: "MIT", licenceSource: "repository", installable: true, security: true, files: 2, bytes: 100, hasScripts: false };
const catalog: CatalogFile = { generated: "2026-11-14T00:00:00Z", publishers: { acme: { name: "Acme", url: "https://github.com/acme", avatar: "" } }, skills: [entry] };
const good: Fake = { files: { "skills/demo-audit/SKILL.md": skillMd(), "skills/demo-audit/references/notes.md": "notes", "README.md": "root" } };

let directory: string; let store: SkillsStore;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "zero-catalog-")); mkdirSync(join(directory, "project")); store = new SkillsStore({ workspace: join(directory, "project"), stateDir: join(directory, "state") }); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("generated catalog", () => {
  const data = loadCatalog();
  it("has pinned commits, unique ids and stars-first ordering", () => {
    expect(data.skills.length).toBeGreaterThan(10);
    expect(new Set(data.skills.map(skill => skill.id)).size).toBe(data.skills.length);
    for (const skill of data.skills) { expect(skill.commit).toMatch(/^[0-9a-f]{40}$/); expect(skill.files).toBeLessThanOrEqual(CATALOG_LIMITS.files); expect(skill.bytes).toBeLessThanOrEqual(CATALOG_LIMITS.bytes); expect(data.publishers[skill.publisher]).toBeDefined(); }
    expect(data.skills.map(skill => skill.stars)).toEqual([...data.skills.map(skill => skill.stars)].sort((a, b) => b - a));
    expect(data.skills.some(skill => skill.security)).toBe(true);
  });
  it("never references a remote image: every avatar is a small data URI or empty", () => {
    for (const publisher of Object.values(data.publishers)) {
      expect(publisher.avatar === "" || /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(publisher.avatar)).toBe(true);
      if (publisher.avatar) expect(Buffer.from(publisher.avatar.split(",")[1]!, "base64").length).toBeLessThanOrEqual(6 * 1024);
    }
  });
  it("gives every skill owner a real avatar, so the browser never has to ask github.com for one", () => {
    for (const owner of new Set(data.skills.map(skill => skill.publisher))) {
      const publisher = data.publishers[owner];
      expect(publisher, owner).toBeDefined();
      expect(publisher!.name.length, owner).toBeGreaterThan(0);
      expect(publisher!.avatar, owner).toMatch(/^data:image\/(png|jpeg);base64,/);
      expect(publisher!.avatar.length, owner).toBeGreaterThan(500);
    }
    expect(JSON.stringify(data)).not.toMatch(/githubusercontent|github\.com\/[^"/]+\.png/);
  });
  it("applies the licence rule: installable only for known permissive licences", () => {
    for (const skill of data.skills) expect(skill.installable, skill.id).toBe(licenceRule(skill.licence).installable);
    expect(data.skills.some(skill => !skill.installable)).toBe(true);
  });
});

describe("licence rule and helpers", () => {
  it("copies permissive licences, marks share-alike, and links out otherwise", () => {
    expect(licenceRule("MIT")).toMatchObject({ installable: true, shareAlike: false });
    expect(licenceRule("CC-BY-SA-4.0")).toMatchObject({ installable: true, shareAlike: true, notice: "Share-alike: keep attribution." });
    expect(licenceRule(null)).toMatchObject({ installable: false });
    expect(licenceRule("GPL-3.0-only").installable).toBe(false);
  });
  it("title-cases folder names and keeps acronyms", () => { expect(titleCase("pr-body")).toBe("PR Body"); expect(titleCase("mcp-builder")).toBe("MCP Builder"); expect(titleCase("diagnosing-bugs")).toBe("Diagnosing Bugs"); expect(titleCase("spec-to-code")).toBe("Spec to Code"); });
  it("flags hidden text, comments, encoded blocks and scripts", () => {
    expect(skillWarnings("plain", false)).toEqual([]);
    expect(skillWarnings("a​b <!-- x --> " + "A".repeat(300), true)).toHaveLength(4);
  });
});

describe("preview and install", () => {
  const service = (repos: Record<string, Fake> = { "acme/skills": good }, gh = fakeGh(repos)) => ({ gh, service: new SkillsCatalogService({ store, gh, catalog, now: () => new Date("2026-11-14T10:00:00Z") }) });
  it("previews the pinned SKILL.md with licence, file list and the verified flag, writing nothing", async () => {
    const { service: s } = service(); const preview = await s.preview({ id: entry.id });
    expect(preview).toMatchObject({ sha: COMMIT, name: "demo-audit", verified: true, licence: { spdx: "MIT", installable: true }, installed: null });
    expect(preview.skillMd.text).toContain("Audit the change."); expect(preview.files.map(file => file.path).sort()).toEqual(["SKILL.md", "references/notes.md"]);
    expect(store.list().skills.filter(skill => skill.scope === "workspace")).toHaveLength(0);
  });
  it("previews an arbitrary repository path without the verified badge", async () => {
    const { service: s } = service(); const preview = await s.preview({ repo: "acme/skills", path: "skills/demo-audit" });
    expect(preview.verified).toBe(false); expect(preview.id).toBeNull();
  });
  it("truncates a long preview for display at 64 KiB", async () => {
    const { service: s } = service({ "acme/skills": { files: { "skills/demo-audit/SKILL.md": skillMd("demo-audit", "x ".repeat(60_000)) } } });
    const preview = await s.preview({ id: entry.id }); expect(preview.skillMd.truncated).toBe(true); expect(Buffer.byteLength(preview.skillMd.text)).toBeLessThanOrEqual(CATALOG_LIMITS.previewText);
  });
  it("installs the pinned folder with a provenance record and refuses to overwrite", async () => {
    const { service: s } = service(); const { skill } = await s.install({ id: entry.id, sha: COMMIT });
    expect(skill.origin).toMatchObject({ repo: "acme/skills", path: "skills/demo-audit", sha: COMMIT, licence: "MIT", catalogId: entry.id, installedAt: "2026-11-14T10:00:00.000Z" });
    expect(readFileSync(join(directory, "state", "skills-library", "skills", "demo-audit", "references", "notes.md"), "utf8")).toBe("notes");
    expect(existsSync(join(directory, "state", "skills-library", "provenance", "demo-audit.json"))).toBe(true);
    expect(s.list().skills[0]!.installed).toEqual({ name: "demo-audit", sha: COMMIT, current: true });
    await expect(s.install({ id: entry.id, sha: COMMIT })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("requires the reviewed SHA to match the catalog pin", async () => {
    const { service: s } = service(); await expect(s.install({ id: entry.id, sha: "b".repeat(40) })).rejects.toMatchObject({ statusCode: 409 });
    await expect(s.install({ id: entry.id })).rejects.toMatchObject({ statusCode: 400 });
  });
  it("installs from an arbitrary repository at an explicit SHA with a null catalog id", async () => {
    const { service: s } = service(); const { skill } = await s.install({ repo: "acme/skills", path: "skills/demo-audit", sha: COMMIT });
    expect(skill.origin).toMatchObject({ catalogId: null, publisher: "acme" });
  });
  it("refuses skills without a copyable licence, private repositories and read-only accounts", async () => {
    const unlicensed = service({ "acme/skills": { ...good, license: null } }).service;
    await expect(unlicensed.install({ repo: "acme/skills", path: "skills/demo-audit", sha: COMMIT })).rejects.toMatchObject({ statusCode: 409 });
    expect((await unlicensed.preview({ repo: "acme/skills", path: "skills/demo-audit" })).licence.installable).toBe(false);
    await expect(service({ "acme/skills": { ...good, private: true } }).service.preview({ id: entry.id })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service().service.install({ id: entry.id, sha: COMMIT }, { canWrite: false })).rejects.toMatchObject({ statusCode: 403 });
  });
  it("reads a skill folder LICENSE file in preference to the repository licence", async () => {
    const proprietary = { license: null, files: { ...good.files, "skills/demo-audit/LICENSE.txt": "All rights reserved. Source available only." } };
    expect((await service({ "acme/skills": proprietary }).service.preview({ id: entry.id })).licence).toMatchObject({ spdx: null, source: "skill folder (custom terms)", installable: false });
    const apache = { license: null, files: { ...good.files, "skills/demo-audit/LICENSE.txt": "Apache License\n Version 2.0, January 2004" } };
    expect((await service({ "acme/skills": apache }).service.preview({ id: entry.id })).licence).toMatchObject({ spdx: "Apache-2.0", installable: true });
  });
  it("enforces size and file caps and rejects symlinks and tampered objects", async () => {
    const big = { files: good.files, sizes: { "skills/demo-audit/SKILL.md": CATALOG_LIMITS.skillMd + 1 } };
    await expect(service({ "acme/skills": big }).service.preview({ id: entry.id })).rejects.toMatchObject({ statusCode: 413 });
    const many = { files: { ...good.files, ...Object.fromEntries(Array.from({ length: CATALOG_LIMITS.files }, (_, index) => [`skills/demo-audit/assets/${index}.txt`, String(index)])) } };
    await expect(service({ "acme/skills": many }).service.install({ id: entry.id, sha: COMMIT })).rejects.toMatchObject({ statusCode: 413 });
    const heavy = { files: good.files, sizes: { "skills/demo-audit/references/notes.md": CATALOG_LIMITS.bytes + 1 } };
    await expect(service({ "acme/skills": heavy }).service.install({ id: entry.id, sha: COMMIT })).rejects.toMatchObject({ statusCode: 413 });
    const link = { files: good.files, modes: { "skills/demo-audit/references/notes.md": "120000" } };
    await expect(service({ "acme/skills": link }).service.install({ id: entry.id, sha: COMMIT })).rejects.toMatchObject({ statusCode: 422 });
    const tampered = { files: good.files, corrupt: "skills/demo-audit/references/notes.md" };
    await expect(service({ "acme/skills": tampered }).service.install({ id: entry.id, sha: COMMIT })).rejects.toMatchObject({ statusCode: 424 });
    expect(store.list().skills.filter(skill => skill.scope === "workspace")).toHaveLength(0);
  });
  it("rejects bad repository, path and ref input before any GitHub call", async () => {
    const { gh, service: s } = service();
    for (const bad of [{ repo: "not a repo" }, { repo: "acme/skills", path: "../etc" }, { repo: "acme/skills", ref: "--upload-pack=x" }, { repo: "acme/skills", extra: 1 }]) await expect(s.preview(bad)).rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect(gh.calls).toEqual([]);
  });
  it("removes only skills added from GitHub", async () => {
    const { service: s } = service(); await s.install({ id: entry.id, sha: COMMIT });
    store.create({ content: skillMd("own-skill") });
    expect(() => s.remove({ name: "own-skill" })).toThrow("added from GitHub");
    expect(s.remove({ name: "demo-audit" })).toEqual({ ok: true });
    expect(existsSync(join(directory, "state", "skills-library", "provenance", "demo-audit.json"))).toBe(false);
    expect(s.list().skills[0]!.installed).toBeNull();
    expect(store.list().skills.some(skill => skill.name === "own-skill")).toBe(true);
  });
});

describe("routes", () => {
  it("serves GET catalog and maps errors to statuses", async () => {
    const s = new SkillsCatalogService({ store, gh: fakeGh({ "acme/skills": good }), catalog });
    expect((await handleSkillsCatalogRequest(s, "skills/catalog", "GET", undefined))?.status).toBe(200);
    expect((await handleSkillsCatalogRequest(s, "skills/catalog/preview", "POST", { id: "missing" }))?.status).toBe(404);
    expect((await handleSkillsCatalogRequest(s, "skills/catalog/install", "POST", { id: entry.id, sha: COMMIT }, { canWrite: false }))?.status).toBe(403);
    expect((await handleSkillsCatalogRequest(s, "skills/catalog/install", "POST", { id: entry.id, sha: COMMIT }))?.status).toBe(201);
    expect((await handleSkillsCatalogRequest(s, "skills/catalog/install", "GET", undefined))?.status).toBe(405);
    expect(await handleSkillsCatalogRequest(s, "sessions", "GET", undefined)).toBeNull();
  });
  it("keeps preview, install and remove browser-only while the catalog read stays open to engines", () => {
    const engine = { engineRequest: true, teamEnabled: false };
    for (const path of ["preview", "install", "remove"]) expect(privilegedRouteDenial(`/api/console/skills/catalog/${path}`, "POST", engine)).toMatchObject({ status: 403, data: { code: "browser_only" } });
    expect(privilegedRouteDenial("/api/console/skills/catalog", "GET", engine)).toBeNull();
    expect(privilegedRouteDenial("/api/console/skills/catalog/install", "POST", { engineRequest: false, teamEnabled: false })).toBeNull();
  });
  it("records skill.install and skill.remove audit events with whitelisted detail keys", () => {
    const install = describeConsoleAudit("skills/catalog/install", "POST", { id: entry.id, sha: COMMIT })!;
    expect(install).toMatchObject({ action: "skill.install", subject: entry.id, detail: { source: "catalog", version: COMMIT.slice(0, 12) } });
    const github = describeConsoleAudit("skills/catalog/install", "POST", { repo: "acme/skills", path: "skills/demo-audit", sha: COMMIT })!;
    expect(github.detail).toMatchObject({ source: "github", repo: "acme/skills" });
    for (const key of Object.keys(github.detail!)) expect(AUDIT_DETAIL_KEYS.has(key)).toBe(true);
    expect(describeConsoleAudit("skills/catalog/remove", "POST", { name: "demo-audit" })).toMatchObject({ action: "skill.remove" });
    expect(describeConsoleAudit("skills/catalog", "GET", undefined)).toBeNull();
  });
});
