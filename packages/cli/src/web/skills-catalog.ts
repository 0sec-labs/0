import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateAgentSkillContent } from "@0/engine";
import { z } from "zod";
import catalogData from "./skills-catalog.generated.json" with { type: "json" };
import { SkillsError, type SkillOrigin, type SkillsStore } from "./skills.js";

/**
 * Skills directory. Capy's model: a curated catalog. The "Verified by 0" badge means 0 listed the skill and
 * pinned a commit, not that the publisher's identity was checked. The skill text enters the model context with
 * operator trust, so adding one is always an explicit click after a preview of the real SKILL.md, the pinned
 * commit and the licence. Nothing auto-updates, scripts in a skill folder are stored but never executed, and
 * all GitHub reads go through the server with the operator's own `gh` login (the browser CSP stays closed).
 */
export const CATALOG_LIMITS = { files: 128, bytes: 4 * 1024 * 1024, skillMd: 128 * 1024, previewText: 64 * 1024, licenceFile: 64 * 1024 } as const;
/** Licences 0 will copy. Anything else (none declared, custom terms) is listed with a link to the source only. */
export const PERMISSIVE_LICENCES: ReadonlySet<string> = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "CC-BY-SA-4.0", "CC-BY-SA-3.0", "Unlicense", "0BSD", "Zlib", "BlueOak-1.0.0"]);

export interface LicenceRule { spdx: string | null; installable: boolean; shareAlike: boolean; notice: string }
export function licenceRule(spdx: string | null | undefined): LicenceRule {
  if (!spdx) return { spdx: null, installable: false, shareAlike: false, notice: "No open licence is declared, so 0 links to the original instead of copying it." };
  if (!PERMISSIVE_LICENCES.has(spdx)) return { spdx, installable: false, shareAlike: false, notice: `${spdx} is not on the list 0 copies. View it on GitHub instead.` };
  if (/^CC-BY-SA/.test(spdx)) return { spdx, installable: true, shareAlike: true, notice: "Share-alike: keep attribution." };
  return { spdx, installable: true, shareAlike: false, notice: `Licensed ${spdx}. Attribution is kept in the provenance record.` };
}

const ACRONYMS: ReadonlyMap<string, string> = new Map(Object.entries({ api: "API", pr: "PR", ctf: "CTF", cvss: "CVSS", owasp: "OWASP", sarif: "SARIF", yara: "YARA", mcp: "MCP", ui: "UI", ci: "CI", cd: "CD", tdd: "TDD", gha: "GHA", ai: "AI", llm: "LLM", pwn: "Pwn", fp: "FP", sql: "SQL", xss: "XSS", adr: "ADR", adrs: "ADRs" }));
export function titleCase(name: string): string {
  return name.split(/[-_]+/).filter(Boolean).map(word => ACRONYMS.get(word.toLowerCase()) ?? word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

export interface CatalogEntry {
  id: string; name: string; title: string; summary: string; repo: string; path: string; ref: string; commit: string; publisher: string; verified: boolean;
  stars: number; pushedAt: string; licence: string | null; licenceSource: string; licenceFile?: string; installable: boolean; security: boolean; files: number; bytes: number; hasScripts: boolean;
}
export interface CatalogPublisher { name: string; url: string; avatar: string }
export interface CatalogFile { generated: string; publishers: Record<string, CatalogPublisher>; skills: CatalogEntry[] }
export function loadCatalog(): CatalogFile { return catalogData as unknown as CatalogFile; }

/** Read-only GitHub API call; resolves to the JSON text. Replaced by a fake in tests. */
export type GhRunner = (path: string) => Promise<string>;
const run = promisify(execFile);
export const ghApi: GhRunner = async path => {
  const { stdout } = await run("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

export class CatalogError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@+-]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;
const FOLDER = /^(?:[A-Za-z0-9._ +@-]+(?:\/[A-Za-z0-9._ +@-]+)*)?$/;
const folderOf = (path: string) => path.replace(/^\/+|\/+$/g, "");

const previewInput = z.union([z.object({ id: z.string().min(1).max(300), ref: z.undefined().optional() }).strict(), z.object({ repo: z.string().regex(REPO), path: z.string().max(1024).default(""), ref: z.string().regex(REF).optional() }).strict()]);
const installInput = z.union([z.object({ id: z.string().min(1).max(300), sha: z.string().regex(SHA) }).strict(), z.object({ repo: z.string().regex(REPO), path: z.string().max(1024).default(""), sha: z.string().regex(SHA), ref: z.string().regex(REF).optional() }).strict()]);
const removeInput = z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64) }).strict();

interface TreeItem { path: string; mode: string; type: string; sha: string; size?: number }
interface Snapshot { repo: string; path: string; ref: string | null; sha: string; items: TreeItem[]; licence: LicenceRule; licenceSource: string; skillMd: Buffer; name: string; description: string; catalogId: string | null; publisher: string | null }
const blobSha = (data: Buffer) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

function classifyLicenceText(text: string): string | null {
  if (/Apache License[\s\S]{0,80}Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/i.test(text) && /MIT License|THE SOFTWARE IS PROVIDED "AS IS"/i.test(text)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return "ISC";
  return null;
}
/** Things a reviewer should see before the text reaches the model. */
export function skillWarnings(text: string, hasScripts: boolean): string[] {
  const warnings: string[] = [];
  if (/[​-‏⁠⁦-⁩‪-‮﻿]/.test(text)) warnings.push("Contains invisible Unicode characters.");
  if (/<!--/.test(text)) warnings.push("Contains HTML comments that are hidden when rendered.");
  if (/[A-Za-z0-9+/]{200,}={0,2}/.test(text)) warnings.push("Contains a long encoded block.");
  if (hasScripts) warnings.push("Bundles scripts. 0 stores them but never runs them.");
  return warnings;
}

export interface CatalogServiceOptions { store: SkillsStore; gh?: GhRunner; catalog?: CatalogFile; now?: () => Date }
export class SkillsCatalogService {
  readonly #store: SkillsStore; readonly #gh: GhRunner; readonly #catalog: CatalogFile; readonly #now: () => Date;
  constructor(options: CatalogServiceOptions) { this.#store = options.store; this.#gh = options.gh ?? ghApi; this.#catalog = options.catalog ?? loadCatalog(); this.#now = options.now ?? (() => new Date()); }

  #entry(id: string): CatalogEntry { const entry = this.#catalog.skills.find(item => item.id === id); if (!entry) throw new CatalogError("This skill is not in the catalog.", 404); return entry; }
  async #json<T>(path: string): Promise<T> {
    try { return JSON.parse(await this.#gh(path)) as T; }
    catch (cause) {
      const text = cause instanceof Error ? `${cause.message} ${(cause as { stderr?: string }).stderr ?? ""}` : "";
      if (/404|Not Found/i.test(text)) throw new CatalogError("GitHub could not find that repository, path or revision.", 404);
      if (/auth|login|401|403|rate limit/i.test(text)) throw new CatalogError("GitHub did not allow the request. Sign in with `gh auth login` or retry later.", 502);
      throw new CatalogError("Could not reach GitHub.", 502);
    }
  }
  async #blob(repo: string, item: TreeItem): Promise<Buffer> {
    const data = await this.#json<{ content?: string; encoding?: string; size?: number }>(`repos/${repo}/git/blobs/${item.sha}`);
    if (data.encoding !== "base64" || typeof data.content !== "string") throw new CatalogError("GitHub returned an unexpected file encoding.", 502);
    const bytes = Buffer.from(data.content, "base64");
    if (blobSha(bytes) !== item.sha) throw new CatalogError(`${item.path} does not match its pinned git object.`, 502);
    return bytes;
  }

  /** Resolve a repo, folder and revision to a pinned commit, check caps and licence, and read SKILL.md. Nothing is written. */
  async #snapshot(spec: { repo: string; path: string; ref?: string | undefined; sha?: string | undefined }, catalogId: string | null, publisher: string | null): Promise<Snapshot> {
    const folder = folderOf(spec.path);
    if (!FOLDER.test(folder) || folder.split("/").some(part => part === "." || part === "..")) throw new CatalogError("Invalid skill folder path.");
    const repo = await this.#json<{ private?: boolean; default_branch?: string; license?: { spdx_id?: string | null } | null }>(`repos/${spec.repo}`);
    if (repo.private) throw new CatalogError("Only public repositories can be added.", 403);
    const sha = spec.sha ?? (SHA.test(spec.ref ?? "") ? spec.ref! : (await this.#json<{ sha?: string }>(`repos/${spec.repo}/commits/${spec.ref ?? repo.default_branch ?? "HEAD"}`)).sha);
    if (!sha || !SHA.test(sha)) throw new CatalogError("Could not resolve a commit.", 502);
    const tree = await this.#json<{ truncated?: boolean; tree?: TreeItem[] }>(`repos/${spec.repo}/git/trees/${sha}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree)) throw new CatalogError("This repository is too large to read as a skill source.", 413);
    const prefix = folder ? `${folder}/` : "";
    const items = tree.tree.filter(item => item.type !== "tree" && item.path.startsWith(prefix));
    if (items.some(item => item.mode === "120000" || item.type === "commit")) throw new CatalogError("Skill folders with symbolic links or submodules cannot be added.", 422);
    const skillItem = items.find(item => item.path === `${prefix}SKILL.md`);
    if (!skillItem) throw new CatalogError("No SKILL.md in that folder.", 404);
    const bytes = items.reduce((total, item) => total + (item.size ?? 0), 0);
    if (skillItem.size === undefined || skillItem.size > CATALOG_LIMITS.skillMd) throw new CatalogError("SKILL.md is larger than 128 KiB.", 413);
    if (items.length > CATALOG_LIMITS.files || bytes > CATALOG_LIMITS.bytes) throw new CatalogError(`The skill folder is larger than ${CATALOG_LIMITS.files} files or ${CATALOG_LIMITS.bytes / 1024 / 1024} MiB.`, 413);
    const skillMd = await this.#blob(spec.repo, skillItem);
    let meta: { name: string; description: string };
    try { meta = validateAgentSkillContent(skillMd.toString("utf8")); } catch (cause) { throw new CatalogError(cause instanceof Error ? cause.message : "Invalid SKILL.md.", 422); }
    let spdx: string | null = repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION" ? repo.license.spdx_id : null; let licenceSource = spdx ? "repository" : "none";
    const licenceItem = items.find(item => /^LICEN[CS]E(\.(txt|md))?$/i.test(item.path.slice(prefix.length)));
    if (licenceItem && (licenceItem.size ?? 0) <= CATALOG_LIMITS.licenceFile) {
      spdx = classifyLicenceText((await this.#blob(spec.repo, licenceItem)).toString("utf8")); licenceSource = spdx ? "skill folder" : "skill folder (custom terms)";
    }
    return { repo: spec.repo, path: folder, ref: spec.ref ?? repo.default_branch ?? null, sha, items, licence: licenceRule(spdx), licenceSource, skillMd, name: meta.name, description: meta.description, catalogId, publisher };
  }
  #resolve(input: { id?: string; repo?: string; path?: string; ref?: string; sha?: string }) {
    if (input.id) { const entry = this.#entry(input.id); return { entry, spec: { repo: entry.repo, path: entry.path, sha: entry.commit, ref: entry.ref } }; }
    return { entry: undefined, spec: { repo: input.repo!, path: input.path ?? "", ref: input.ref, sha: input.sha } };
  }
  #installed(name: string, repo: string, path: string): { name: string; sha: string } | null {
    const origin = this.#store.origins().get(name);
    return origin && origin.repo === repo && origin.path === path ? { name, sha: origin.sha } : null;
  }

  list() {
    const origins = this.#store.origins();
    const skills = this.#catalog.skills.map(entry => {
      const origin = origins.get(entry.name);
      const installed = origin && origin.repo === entry.repo && origin.path === entry.path ? { name: entry.name, sha: origin.sha, current: origin.sha === entry.commit } : null;
      return { ...entry, installable: entry.installable && licenceRule(entry.licence).installable, installed };
    });
    return { generated: this.#catalog.generated, publishers: this.#catalog.publishers, skills };
  }

  async preview(raw: unknown) {
    const parsed = parse(previewInput, raw); const { entry, spec } = this.#resolve(parsed);
    const snap = await this.#snapshot(spec, entry?.id ?? null, entry?.publisher ?? null);
    const text = snap.skillMd; const truncated = text.length > CATALOG_LIMITS.previewText;
    const hasScripts = snap.items.some(item => /(^|\/)scripts\//.test(item.path) || /\.(sh|py|js|mjs|ts|rb|ps1|bat)$/.test(item.path));
    const prefix = snap.path ? `${snap.path}/` : "";
    return {
      id: entry?.id ?? null, repo: snap.repo, path: snap.path, ref: snap.ref, sha: snap.sha, name: snap.name, title: entry?.title ?? titleCase(snap.name), description: snap.description,
      verified: Boolean(entry && entry.commit === snap.sha), publisher: snap.publisher ?? snap.repo.split("/")[0],
      licence: { ...snap.licence, source: snap.licenceSource, attribution: `${snap.repo}${snap.path ? `/${snap.path}` : ""} at ${snap.sha.slice(0, 12)}` },
      skillMd: { text: text.subarray(0, CATALOG_LIMITS.previewText).toString("utf8"), truncated, bytes: text.length },
      files: snap.items.map(item => ({ path: item.path.slice(prefix.length), size: item.size ?? 0 })), bytes: snap.items.reduce((total, item) => total + (item.size ?? 0), 0), hasScripts,
      warnings: skillWarnings(text.toString("utf8"), hasScripts), installed: this.#installed(snap.name, snap.repo, snap.path),
    };
  }

  /** The caller echoes the reviewed SHA; the files are re-fetched at exactly that commit and every blob is checked against its git object id. */
  async install(raw: unknown, access: { canWrite?: boolean } = {}) {
    if (access.canWrite === false) throw new CatalogError("This account has read-only workspace access.", 403);
    const parsed = parse(installInput, raw);
    if ("id" in parsed && parsed.sha !== this.#entry(parsed.id).commit) throw new CatalogError("The catalog entry changed since you reviewed it. Preview it again.", 409);
    const { entry, spec } = this.#resolve(parsed); const snap = await this.#snapshot(spec, entry?.id ?? null, entry?.publisher ?? null);
    if (!snap.licence.installable) throw new CatalogError(snap.licence.notice, 409);
    const prefix = snap.path ? `${snap.path}/` : ""; const files: Array<{ path: string; encoding: "base64"; content: string }> = [];
    const queue = [...snap.items]; const loaded = new Map<string, Buffer>();
    await Promise.all(Array.from({ length: 6 }, async () => { for (let item = queue.shift(); item; item = queue.shift()) loaded.set(item.path, item.path === `${prefix}SKILL.md` ? snap.skillMd : await this.#blob(snap.repo, item)); }));
    let revision = createHash("sha256");
    for (const item of snap.items) { const bytes = loaded.get(item.path)!; files.push({ path: item.path.slice(prefix.length), encoding: "base64", content: bytes.toString("base64") }); revision = revision.update(item.path).update("\0").update(bytes); }
    const origin: SkillOrigin = { repo: snap.repo, path: snap.path, ref: snap.ref, sha: snap.sha, licence: snap.licence.spdx, licenceSource: snap.licenceSource, catalogId: entry?.id ?? null, publisher: snap.publisher ?? snap.repo.split("/")[0]!, installedAt: this.#now().toISOString(), revision: revision.digest("hex") };
    return { skill: this.#store.import({ bundle: { format: "agent-skill", version: 1, name: snap.name, files } }, origin) };
  }

  remove(raw: unknown, access: { canWrite?: boolean } = {}) { const { name } = parse(removeInput, raw); this.#store.removeAdded(name, access); return { ok: true }; }
}
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> { const value = schema.safeParse(input); if (!value.success) throw new CatalogError("Invalid skill catalog request."); return value.data; }

/** `path` is relative to /api/console/. Returns null when the route is not a catalog route. */
export async function handleSkillsCatalogRequest(service: SkillsCatalogService, path: string, method: string, input: unknown, access: { canWrite?: boolean } = {}): Promise<{ status: number; data: unknown } | null> {
  if (!/^skills\/catalog(?:\/|$)/.test(path)) return null;
  try {
    if (path === "skills/catalog" && method === "GET") return { status: 200, data: service.list() };
    if (path === "skills/catalog/preview" && method === "POST") return { status: 200, data: await service.preview(input) };
    if (path === "skills/catalog/install" && method === "POST") return { status: 201, data: await service.install(input, access) };
    if (path === "skills/catalog/remove" && method === "POST") return { status: 200, data: service.remove(input, access) };
    return { status: 405, data: { error: "Method not allowed." } };
  } catch (cause) {
    if (cause instanceof CatalogError || cause instanceof SkillsError) return { status: cause instanceof CatalogError ? cause.statusCode : cause.statusCode, data: { error: cause.message } };
    throw cause;
  }
}
