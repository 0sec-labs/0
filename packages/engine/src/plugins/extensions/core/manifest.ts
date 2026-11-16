/**
 * Extension manifest parsing. Pure: takes the files of a folder, returns what the extension DECLARES.
 * Read order, first hit wins:
 *   1. `extension.json`               (preferred; optional "0" block or the same keys at top level)
 *   2. `.claude-plugin/plugin.json`   (Claude Code layout: skills, .mcp.json)
 *   3. `plugin.json`                  (same fields plus an optional "0" object)
 *   4. a bare SKILL.md folder         (root SKILL.md, or .agents/skills/<x>/SKILL.md)
 * Claude `hooks`, `commands` and `agents` are never supported: they are reported as `ignored`, never run.
 */
import { posix } from "node:path";
import { z } from "zod";
import { isSafeExtensionEnvName } from "./env.js";
import { type FolderFile, textOf } from "./files.js";
import { err, ok, type Result } from "./result.js";

export type ManifestFormat = "extension" | "claude" | "plugin-json" | "skill-folder";
export interface McpServerDecl { name: string; transport: "stdio" | "http" | "sse"; command?: string; args: string[]; url?: string; env: string[]; headers: string[] }
export interface ConnectorDecl { service: string; auth: "token" | "oauth-device" | "cli"; env: string[]; hosts: string[]; read: string[]; write: string[]; surface: string | null }
export interface SkillDecl { name: string; description: string; path: string }
export interface ExtensionManifest {
  format: ManifestFormat; manifestPath: string | null;
  name: string; version: string; description: string; license: string | null;
  skills: SkillDecl[]; mcpServers: McpServerDecl[]; connector: ConnectorDecl | null;
  scope: string | null; verify: string | null;
  requires: { bins: string[]; env: string[]; zero: string | null };
  /** Files bash can run (scripts/, executables, shell/py/js files). Nothing runs except through bash. */
  scripts: string[];
  ignored: string[];
}

const NAME = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
export const isExtensionName = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && NAME.test(value);
export function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z]+/, "").replace(/[._-]{2,}/g, "-").replace(/[._-]+$/, "").slice(0, 64);
}

const envName = z.string().refine(isSafeExtensionEnvName, "not an allowed variable name: use UPPER_CASE ending in _TOKEN, _KEY, _SECRET, _URL, _ID, _HOST ... (PATH, GIT_*, LD_*, NODE_OPTIONS and other loader variables are never allowed)");
const text = z.string().min(1).max(512).refine(s => !s.includes("\0"));
const relPath = text.refine(p => !p.includes("\\") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && ![".", ".."].includes(posix.normalize(p)) && !posix.normalize(p).startsWith("../"), "must be a relative path inside the extension").transform(p => posix.normalize(p).replace(/^\.\//, "").replace(/\/$/, ""));
const list = <T extends z.ZodType>(item: T, max = 64) => z.array(item).max(max).default([]);

const connectorSchema = z.object({
  service: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), auth: z.enum(["token", "oauth-device", "cli"]), env: list(envName), hosts: list(z.string().regex(/^[a-z0-9*]([a-z0-9.*-]*[a-z0-9])?$/i), 32),
  access: z.object({ read: list(text), write: list(text) }).default({ read: [], write: [] }), surface: relPath.optional(),
});
const zeroSchema = z.object({
  connector: connectorSchema.optional(), scope: relPath.optional(), verify: relPath.optional(),
  requires: z.object({ bins: list(text, 32), env: list(envName), "0": z.string().max(32).optional() }).default({ bins: [], env: [] }),
});
const mcpEntry = z.object({ command: z.string().optional(), url: z.string().optional(), type: z.string().optional(), transport: z.string().optional(), args: list(z.string(), 128), env: z.record(z.string(), z.string()).default({}), headers: z.record(z.string(), z.string()).default({}) })
  .refine(s => s.command || s.url, "needs a command or a url");
const mcpMap = z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), mcpEntry);
const baseSchema = z.object({
  name: z.string().optional(), version: z.string().max(64).optional(), description: z.string().optional(), license: z.string().optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(), mcpServers: z.union([z.string(), mcpMap]).optional(),
  "0": z.unknown().optional(),
});

const bad = (message: string) => err("invalid_manifest", message);
const zodMessage = (e: z.ZodError) => e.issues.slice(0, 3).map(i => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ");

class Tree {
  readonly #files: Map<string, FolderFile>;
  constructor(readonly files: readonly FolderFile[]) { this.#files = new Map(files.map(f => [f.path, f])); }
  has(path: string) { return this.#files.has(path); }
  dir(path: string) { const prefix = `${path}/`; return this.files.some(f => f.path.startsWith(prefix)); }
  json(path: string): Result<unknown> {
    const f = this.#files.get(path);
    if (!f || f.size > 256 * 1024) return bad(`${path} must be a regular file under 256 KB.`);
    try { return ok(JSON.parse(f.bytes.toString("utf8"))); } catch { return bad(`${path} is not valid JSON.`); }
  }
  children(path: string): string[] { const prefix = path ? `${path}/` : ""; return [...new Set(this.files.filter(f => f.path.startsWith(prefix)).map(f => f.path.slice(prefix.length).split("/")).filter(p => p.length > 1).map(p => p[0]!))].sort(); }
}

function frontmatter(content: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.slice(0, 64 * 1024))?.[1] ?? "";
  const field = (key: string) => { const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim(); return m ? m.replace(/^["']|["']$/g, "") : undefined; };
  return { name: field("name"), description: field("description") };
}
function skillAt(tree: Tree, folder: string, fallback: string): SkillDecl | null {
  const content = textOf(tree.files, folder ? `${folder}/SKILL.md` : "SKILL.md");
  if (content === undefined) return null;
  const fm = frontmatter(content);
  return { name: fm.name ?? fallback, description: fm.description ?? "", path: folder || "." };
}
const skillsIn = (tree: Tree, folder: string): SkillDecl[] => {
  const direct = skillAt(tree, folder, folder.split("/").pop() ?? "skill");
  if (direct) return [direct];
  return tree.children(folder).flatMap(child => { const s = skillAt(tree, `${folder}/${child}`, child); return s ? [s] : []; });
};

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|ps1|bat|pl)$/i;
const scriptsOf = (tree: Tree): string[] => tree.files.filter(f => f.path.startsWith("scripts/") || f.executable || SCRIPT_EXT.test(f.path)).map(f => f.path).sort();

function mcpDecls(map: z.infer<typeof mcpMap>): Result<McpServerDecl[]> {
  const out: McpServerDecl[] = [];
  for (const [name, s] of Object.entries(map)) {
    const env = Object.keys(s.env);
    const badEnv = env.find(k => !isSafeExtensionEnvName(k));
    if (badEnv) return bad(`MCP server ${name} sets a disallowed environment variable ${JSON.stringify(badEnv)}: names must match the allowed pattern (UPPER_CASE ending in _TOKEN, _KEY, _SECRET, _URL, _ID, _HOST ...) and never be a loader variable such as PATH, PYTHONPATH, NODE_PATH, GIT_*, LD_*, DYLD_*, BASH_ENV or NODE_OPTIONS.`);
    const type = s.type ?? s.transport;
    out.push({ name, transport: s.url ? (type === "sse" ? "sse" : "http") : "stdio", ...(s.command ? { command: s.command } : {}), args: s.args, ...(s.url ? { url: s.url } : {}), env: env.sort(), headers: Object.keys(s.headers).sort() });
  }
  return ok(out);
}

function fromJson(tree: Tree, raw: unknown, format: ManifestFormat, manifestPath: string, fallback: string): Result<ExtensionManifest> {
  const parsed = baseSchema.safeParse(raw);
  if (!parsed.success) return bad(zodMessage(parsed.error));
  const m = parsed.data; const record = raw as Record<string, unknown>;
  const name = m.name ?? fallback;
  if (!isExtensionName(name)) return bad(`Extension name ${JSON.stringify(name)} must be lowercase letters, digits and . _ - (start with a letter).`);
  const folders: string[] = [];
  if (m.skills === undefined) { if (tree.dir("skills")) folders.push("skills"); }
  else for (const p of typeof m.skills === "string" ? [m.skills] : m.skills) { const r = relPath.safeParse(p); if (!r.success) return bad(`skills: ${zodMessage(r.error)}`); folders.push(r.data); }
  let servers: McpServerDecl[] = [];
  let mcpSource: unknown = m.mcpServers;
  if (typeof mcpSource === "string") { const p = relPath.safeParse(mcpSource); if (!p.success) return bad(`mcpServers: ${zodMessage(p.error)}`); const j = tree.json(p.data); if (!j.ok) return j; mcpSource = j.value; }
  else if (mcpSource === undefined && tree.has(".mcp.json")) { const j = tree.json(".mcp.json"); if (!j.ok) return j; mcpSource = j.value; }
  if (mcpSource !== undefined) {
    const inner = (mcpSource && typeof mcpSource === "object" && "mcpServers" in mcpSource ? (mcpSource as { mcpServers: unknown }).mcpServers : mcpSource);
    const map = mcpMap.safeParse(inner);
    if (!map.success) return bad(`MCP servers: ${zodMessage(map.error)}`);
    const d = mcpDecls(map.data); if (!d.ok) return d; servers = d.value;
  }
  // extension.json may put the 0-only keys at top level or in "0"; plugin.json only in "0"; Claude layout has none.
  const zeroRaw = format === "claude" ? {} : (m["0"] ?? (format === "extension" ? record : {}));
  const zero = zeroSchema.safeParse(zeroRaw);
  if (!zero.success) return bad(`"0": ${zodMessage(zero.error)}`);
  const z0 = zero.data;
  for (const [label, path] of [["verify", z0.verify], ["scope", z0.scope]] as const) if (path && !tree.has(path)) return bad(`${label} points at ${path}, which does not exist.`);
  if (z0.connector?.surface && !tree.has(z0.connector.surface) && !tree.dir(z0.connector.surface)) return bad(`connector.surface points at ${z0.connector.surface}, which does not exist.`);
  const connector: ConnectorDecl | null = z0.connector ? { service: z0.connector.service, auth: z0.connector.auth, env: [...new Set(z0.connector.env)].sort(), hosts: z0.connector.hosts, read: z0.connector.access.read, write: z0.connector.access.write, surface: z0.connector.surface ?? null } : null;
  const ignored = ["hooks", "commands", "agents"].filter(k => record[k] !== undefined || tree.dir(k));
  return ok({
    format, manifestPath, name, version: m.version ?? "0.0.0", description: (m.description ?? "").slice(0, 500), license: m.license?.slice(0, 100) ?? null,
    skills: folders.flatMap(f => skillsIn(tree, f)), mcpServers: servers, connector, scope: z0.scope ?? null, verify: z0.verify ?? null,
    requires: { bins: z0.requires.bins, env: [...new Set(z0.requires.env)].sort(), zero: z0.requires["0"] ?? null }, scripts: scriptsOf(tree), ignored,
  });
}

export function parseManifest(files: readonly FolderFile[], options: { fallbackName?: string } = {}): Result<ExtensionManifest> {
  const tree = new Tree(files); const fallback = sanitizeName(options.fallbackName ?? "");
  for (const [path, format] of [["extension.json", "extension"], [".claude-plugin/plugin.json", "claude"], ["plugin.json", "plugin-json"]] as const) {
    if (!tree.has(path)) continue;
    const json = tree.json(path); if (!json.ok) return json;
    if (!json.value || typeof json.value !== "object" || Array.isArray(json.value)) return bad(`${path} must be an object.`);
    if (format === "plugin-json" && Array.isArray((json.value as { tools?: unknown }).tools) && tree.has("plugin.js")) return err("legacy_executable", "This is the old executable plugin format (plugin.js with tools). It is not supported; re-express it as scripts or an MCP server.");
    return fromJson(tree, json.value, format, path, fallback);
  }
  const root = skillAt(tree, "", fallback);
  const skills = root ? [root] : skillsIn(tree, ".agents/skills");
  if (!skills.length) return bad("No manifest found: expected extension.json, .claude-plugin/plugin.json, plugin.json or a SKILL.md.");
  const name = root ? (isExtensionName(root.name) ? root.name : fallback) : (fallback || skills[0]!.name);
  if (!isExtensionName(name)) return bad(`Cannot derive an extension name (${JSON.stringify(name)}).`);
  return ok({ format: "skill-folder", manifestPath: null, name, version: "0.0.0", description: root?.description ?? skills.map(s => s.name).join(", "), license: null, skills, mcpServers: [], connector: null, scope: null, verify: null, requires: { bins: [], env: [], zero: null }, scripts: scriptsOf(tree), ignored: [] });
}
