/**
 * Repo-controlled configuration may only SUGGEST extensions. This module reads a cloned repo's `.0/plugins.json`,
 * `.0/extensions.json`, `.claude/settings.json` and `.mcp.json` and returns what they ask for as plain data. It has
 * no access to the installer or the store: nothing here installs, enables, or runs anything. The UI shows each
 * suggestion with the normal install prompt; ignoring it means nothing runs.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Suggestion { from: string; kind: "extension" | "mcp-server"; source: string; detail?: string }

function json(path: string): unknown {
  try { const s = lstatSync(path); if (!s.isFile() || s.size > 256 * 1024) return undefined; return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function readRepoSuggestions(projectDir: string): Suggestion[] {
  const out: Suggestion[] = [];
  for (const file of [".0/extensions.json", ".0/plugins.json"]) {
    const raw = obj(json(join(projectDir, file)));
    const list = Array.isArray(raw["extensions"]) ? raw["extensions"] : Array.isArray(raw["plugins"]) ? raw["plugins"] : Array.isArray(json(join(projectDir, file))) ? json(join(projectDir, file)) as unknown[] : [];
    for (const item of list) {
      const source = typeof item === "string" ? item : typeof obj(item)["source"] === "string" ? String(obj(item)["source"]) : null;
      if (source) out.push({ from: file, kind: "extension", source: source.slice(0, 300) });
    }
  }
  const claude = obj(json(join(projectDir, ".claude/settings.json")));
  for (const [name, on] of Object.entries(obj(claude["enabledPlugins"]))) if (on) out.push({ from: ".claude/settings.json", kind: "extension", source: name.slice(0, 200) });
  for (const [name] of Object.entries(obj(claude["mcpServers"]))) out.push({ from: ".claude/settings.json", kind: "mcp-server", source: name.slice(0, 100) });
  for (const file of [".mcp.json", ".0/mcp.json"]) {
    const raw = obj(json(join(projectDir, file)));
    for (const [name, def] of Object.entries(obj(raw["mcpServers"] ?? raw))) if (def && typeof def === "object") out.push({ from: file, kind: "mcp-server", source: name.slice(0, 100), detail: String(obj(def)["command"] ?? obj(def)["url"] ?? "").slice(0, 200) });
  }
  return out;
}
