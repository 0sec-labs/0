/**
 * Read-only reader of the OLD stores. It never writes, deletes or renames anything. Every file is read leniently:
 * an unreadable or malformed record is reported as a problem, not a crash, and does not stop the rest.
 *   ~/.0/plugins/<id>/{plugin.json,plugin.js,source.json}   executable plugins (GitHub installs and others)
 *   ~/.0/plugin-enablement/<hash>.json                       per-project enablement of those
 *   ~/.0/executable-plugins/registry.json                    model-authored plugins (self_extend)
 *   ~/.0/mcp-servers.json                                    custom MCP servers
 *   ~/.0/service-plugins.json                                service connections
 *   ~/.0/skills-library/{skills,provenance}                  custom skills and skills installed from GitHub
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../../../shared/index.js";
import { gitTreeHash, type FolderFile } from "../core/files.js";
import { readFolder } from "../adapters/fs-folder.js";

export interface LegacyPlugin { id: string; dir: string; version: string; capabilities: string[]; source: { repo: string; ref: string | null; sha: string; permissionHash?: string } | null }
export interface LegacyAuthored { id: string; name: string; kind: string; dir: string }
export interface LegacyMcp { id: string; name: string; transport: string; command?: string; args: string[]; url?: string; envNames: string[]; headerNames: string[]; enabled: boolean }
export interface LegacyService { id: string; enabled: boolean }
export interface LegacySkill { name: string; dir: string; files: FolderFile[]; treeHash: string; origin: { repo: string; path: string; ref: string | null; sha: string; installedAt: string } | null }
export interface LegacyData {
  plugins: LegacyPlugin[]; enablement: Array<{ project: string; ids: string[] }>; authored: LegacyAuthored[]; mcp: LegacyMcp[]; services: LegacyService[]; skills: LegacySkill[]; problems: string[];
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
function readJson(path: string, problems: string[]): unknown {
  try { const s = lstatSync(path); if (!s.isFile() || s.size > 16 * 1024 * 1024) { problems.push(`${path}: not a regular file under 16 MB`); return undefined; } return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${path}: unreadable (${(error as Error).message.slice(0, 80)})`); return undefined; }
}
const dirs = (path: string): string[] => { try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; } };
const files = (path: string): string[] => { try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort(); } catch { return []; } };

export function readLegacy(home?: string): LegacyData {
  const state = homeStateDir(home); const problems: string[] = [];
  const data: LegacyData = { plugins: [], enablement: [], authored: [], mcp: [], services: [], skills: [], problems };

  for (const id of dirs(join(state, "plugins"))) {
    const dir = join(state, "plugins", id);
    if (!existsSync(join(dir, "plugin.json"))) continue;
    const manifest = rec(readJson(join(dir, "plugin.json"), problems)); const src = rec(readJson(join(dir, "source.json"), problems));
    const tools = Array.isArray(manifest["tools"]) ? manifest["tools"] as unknown[] : [];
    const capabilities = [...new Set(tools.flatMap(t => Array.isArray(rec(t)["capabilities"]) ? (rec(t)["capabilities"] as unknown[]).filter((c): c is string => typeof c === "string") : []))].sort();
    const github = src["source"] === "github" && str(src["repo"]) && str(src["sha"]);
    data.plugins.push({ id, dir, version: str(manifest["version"]) ?? "", capabilities, source: github ? { repo: str(src["repo"])!, ref: str(src["ref"]) ?? null, sha: str(src["sha"])!, ...(str(src["permissionHash"]) ? { permissionHash: str(src["permissionHash"])! } : {}) } : null });
  }
  for (const file of files(join(state, "plugin-enablement")).filter(f => f.endsWith(".json"))) {
    const raw = rec(readJson(join(state, "plugin-enablement", file), problems));
    if (str(raw["project"])) data.enablement.push({ project: str(raw["project"])!, ids: Object.keys(rec(raw["enabled"])) });
  }
  const registry = rec(readJson(join(state, "executable-plugins", "registry.json"), problems));
  for (const [id, value] of Object.entries(rec(registry["plugins"]))) {
    const r = rec(value); const active = (Array.isArray(r["versions"]) ? r["versions"] as unknown[] : []).map(rec).find(v => v["versionId"] === r["activeVersionId"]);
    data.authored.push({ id, name: str(r["name"]) ?? id, kind: str(active?.["kind"]) ?? "tool", dir: join(state, "executable-plugins") });
  }
  const mcp = readJson(join(state, "mcp-servers.json"), problems);
  for (const item of Array.isArray(mcp) ? mcp : []) {
    const s = rec(item); const id = str(s["id"]); if (!id) continue;
    data.mcp.push({ id, name: str(s["name"]) ?? id, transport: str(s["transport"]) ?? "stdio", ...(str(s["command"]) ? { command: str(s["command"])! } : {}), args: Array.isArray(s["args"]) ? (s["args"] as unknown[]).filter((a): a is string => typeof a === "string") : [], ...(str(s["url"]) ? { url: str(s["url"])! } : {}), envNames: Object.keys(rec(s["env"])).sort(), headerNames: Object.keys(rec(s["headers"])).sort(), enabled: s["enabled"] === true });
  }
  const services = readJson(join(state, "service-plugins.json"), problems);
  for (const item of Array.isArray(services) ? services : []) { const s = rec(item); if (str(s["id"])) data.services.push({ id: str(s["id"])!, enabled: s["enabled"] === true }); }

  const library = join(state, "skills-library");
  for (const name of dirs(join(library, "skills"))) {
    const dir = join(library, "skills", name); const folder = readFolder(dir);
    if (!folder.ok) { problems.push(`skill ${name}: ${folder.error.message}`); continue; }
    const o = rec(readJson(join(library, "provenance", `${name}.json`), problems));
    const origin = str(o["repo"]) && /^[0-9a-f]{40}$/.test(str(o["sha"]) ?? "") ? { repo: str(o["repo"])!, path: str(o["path"]) ?? "", ref: str(o["ref"]) ?? null, sha: str(o["sha"])!, installedAt: str(o["installedAt"]) ?? "" } : null;
    data.skills.push({ name, dir, files: folder.value, treeHash: gitTreeHash(folder.value), origin });
  }
  return data;
}
