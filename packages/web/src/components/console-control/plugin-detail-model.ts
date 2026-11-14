/** Pure view-model for the plugin detail page and Explore list. Facts only: nothing is invented beyond what the host reports. */
import type { PluginItem } from "./contracts";
import type { McpServerEntry } from "./mcp-contract";
import { commandPreview, countLabel, safeLogo } from "./mcp-model";

export type PluginRef = { kind: "plugin" | "service" | "mcp"; id: string };
export type PageTone = "neutral" | "success" | "warning";

/** The page id is `kind:id` so a built-in service, a custom server and a registry plugin that share an id never collide. A bare id is accepted and resolved in a fixed order. */
export const pluginPath = (ref: PluginRef) => `/plugins/${ref.kind}:${encodeURIComponent(ref.id)}`;
export const RESERVED_PLUGIN_SEGMENTS = ["skills", "explore"] as const;
export function parsePluginRef(segment: string | undefined): { kind?: PluginRef["kind"]; id: string } | null {
  if (!segment) return null;
  let value: string;
  try { value = decodeURIComponent(segment); } catch { return null; }
  const match = /^(plugin|service|mcp):(.+)$/.exec(value);
  return match ? { kind: match[1] as PluginRef["kind"], id: match[2]! } : { id: value };
}

export interface ServiceLike {
  id: string; name: string; description: string; category: string; docsUrl: string;
  configured: boolean; enabled: boolean; error?: string; testedAt: string | null;
  tools: { name: string; description: string }[]; skills?: { name: string; description: string }[]; logo?: string;
}

export type PluginSource =
  | { kind: "plugin"; item: PluginItem }
  | { kind: "service"; item: ServiceLike }
  | { kind: "mcp"; item: McpServerEntry };

export interface RailEntry { label: string; value: string; href?: string; mono?: boolean }
export interface McpCard { transport: string; target: { label: "Command" | "URL"; value: string }; cwd?: string; envKeys: string[]; headerNames: string[]; lastTest: string }
export interface PluginPageView {
  ref: PluginRef; name: string; kindLabel: "MCP server" | "Tool plugin"; description: string; logo?: string;
  verified: boolean; verifiedBy?: string;
  status: { label: string; tone: PageTone; added: boolean };
  tools: { name: string; description: string }[]; skills: { name: string; description: string }[];
  mcp?: McpCard; rail: RailEntry[]; permissions: string[]; reportUrl?: string;
}

const CAPABILITY_WORDING: Record<string, string> = {
  compute: "Run calculations on this machine",
  "model-call": "Call your connected AI models",
  network: "Send and receive data over the network",
  "filesystem-read": "Read files in your workspace",
  "filesystem-write": "Create and change files in your workspace",
  "process-exec": "Run programs on this machine",
  "findings-write": "Add and update findings",
};
/** Plain-English line for one plugin capability. An unknown capability is shown as reported, never hidden. */
export const permissionWording = (capability: string) => CAPABILITY_WORDING[capability] ?? capability;

/** The first `limit` rows plus how many are hidden, for a "View N more" link. */
export function sliceMore<T>(items: readonly T[], limit = 5, expanded = false): { visible: T[]; hidden: number; label: string | null } {
  const hidden = expanded ? 0 : Math.max(0, items.length - limit);
  return { visible: hidden ? items.slice(0, limit) : items.slice(), hidden, label: hidden ? `View ${hidden} more` : null };
}

const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const when = (iso?: string | null) => { if (!iso) return null; const date = new Date(iso); return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10); };
const transportLabel = (transport: McpServerEntry["transport"]) => transport === "stdio" ? "Command (stdio)" : transport === "sse" ? "SSE" : "HTTP";
const clean = (value: string | undefined | null) => (value ?? "").trim();
/** Real descriptions only: a list of tool ids or a bare tool name is not a description. */
export const cleanDescription = (item: Pick<PluginItem, "description">, toolNames: readonly string[] = []) => {
  const text = clean(item.description);
  return text && !/^[a-z][a-z0-9_]*(?:, [a-z][a-z0-9_]*)+$/.test(text) && !/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(text) && !toolNames.includes(text) ? text : "";
};

export function mcpPermissions(item: McpServerEntry): string[] {
  const out = item.transport === "stdio" ? ["Run a program on this machine as your user"] : [`Connect to ${item.url ? hostOf(item.url) : "a remote server"}`];
  if (item.envKeys.length) out.push(`Receive ${countLabel(item.envKeys.length, "environment variable")} you set`);
  if (item.headerNames.length) out.push(`Send ${countLabel(item.headerNames.length, "saved header")} with each request`);
  out.push("Its output is treated as untrusted data");
  return out;
}

export function buildPluginView(source: PluginSource, opts: { toolNames?: readonly string[] } = {}): PluginPageView {
  if (source.kind === "plugin") {
    const item = source.item;
    const enabled = item.state === "enabled";
    const github = item.source === "github";
    const verified = item.signature === "verified";
    const rail: RailEntry[] = [];
    if (github && item.repo) rail.push({ label: "Repository", value: item.sha ? `${item.repo} @ ${item.sha.slice(0, 12)}` : item.repo, mono: true, ...(GITHUB_REPO.test(item.repo) ? { href: `https://github.com/${item.repo}` } : {}) });
    rail.push({ label: "Made by", value: github && item.repo ? item.repo.split("/")[0]! : item.source === "local" ? "You (local file)" : "Listed in the plugin registry" });
    if (verified) rail.push({ label: "Verified by", value: "Registry signature" });
    if (item.version) rail.push({ label: "Version", value: github && item.sha ? `${item.version} (pinned, never updates by itself)` : item.version });
    const tools = (item.tools ?? []).map(tool => ({ name: tool.name, description: tool.description }));
    return {
      ref: { kind: "plugin", id: item.id }, name: item.name, kindLabel: "Tool plugin", description: cleanDescription(item, opts.toolNames), logo: safeLogo(item.logo),
      verified, verifiedBy: verified ? "Registry signature" : undefined,
      status: item.error ? { label: "Needs attention", tone: "warning", added: false } : enabled ? { label: "Added", tone: "success", added: true } : item.state === "installed" ? { label: "Installed, off", tone: "neutral", added: false } : { label: "Not added", tone: "neutral", added: false },
      tools, skills: (item.skills ?? []).map(skill => ({ name: skill.name, description: skill.description })), rail, permissions: item.capabilities.map(permissionWording),
      reportUrl: github && item.repo && GITHUB_REPO.test(item.repo) ? `https://github.com/${item.repo}/issues` : undefined,
    };
  }
  if (source.kind === "service") {
    const item = source.item;
    const healthy = item.configured && item.enabled && !item.error;
    return {
      ref: { kind: "service", id: item.id }, name: item.name, kindLabel: "MCP server", description: clean(item.description), logo: safeLogo(item.logo),
      verified: true, verifiedBy: "0",
      status: !item.configured ? { label: "Needs connection", tone: "warning", added: false } : item.error ? { label: "Needs attention", tone: "warning", added: false } : healthy ? { label: "Added", tone: "success", added: true } : { label: "Off", tone: "neutral", added: false },
      tools: item.configured ? item.tools.map(tool => ({ name: tool.name, description: tool.description })) : [], skills: item.configured ? (item.skills ?? []) : [],
      mcp: { transport: "Built-in connector", target: { label: "URL", value: "Managed by 0" }, envKeys: [], headerNames: [], lastTest: when(item.testedAt) ? `Tested ${when(item.testedAt)}` : item.configured ? "Not tested yet" : "Not connected" },
      rail: [
        { label: "Made by", value: "Built in to 0" }, { label: "Verified by", value: "0" }, { label: "Category", value: item.category },
        ...(/^https:\/\//.test(item.docsUrl) ? [{ label: "Documentation", value: hostOf(item.docsUrl), href: item.docsUrl }] : []),
      ],
      permissions: [`Send requests to ${item.name} using the credentials you save`, "Credentials stay in the operator store, never in conversations", "Its output is treated as untrusted data"],
    };
  }
  const item = source.item;
  const stdio = item.transport === "stdio";
  const view = !item.enabled ? { label: "Off", tone: "neutral" as const, added: false } : item.status === "ok" ? { label: "Added", tone: "success" as const, added: true } : item.status === "error" ? { label: "Needs attention", tone: "warning" as const, added: false } : { label: "Added, not tested", tone: "neutral" as const, added: true };
  const tested = when(item.testedAt);
  return {
    ref: { kind: "mcp", id: item.id }, name: item.name, kindLabel: "MCP server", description: stdio ? "A command-line MCP server you added." : `A remote MCP server you added at ${item.url ? hostOf(item.url) : "a URL"}.`, logo: safeLogo(item.logo),
    verified: false, status: view,
    tools: item.tools.map(tool => ({ name: tool.name, description: tool.description })), skills: [],
    mcp: {
      transport: transportLabel(item.transport),
      target: stdio ? { label: "Command", value: item.command ? commandPreview(item.command, item.args) : "Not reported" } : { label: "URL", value: item.url ?? "Not reported" },
      cwd: stdio ? item.cwd : undefined, envKeys: item.envKeys, headerNames: item.headerNames,
      lastTest: item.status === "error" ? `Failed${tested ? ` on ${tested}` : ""}${item.statusMessage ? `: ${item.statusMessage}` : ""}` : item.status === "ok" ? `Passed${tested ? ` on ${tested}` : ""}${item.toolCount ? `, ${countLabel(item.toolCount, "tool")}` : ""}` : "Not tested yet",
    },
    rail: [{ label: "Made by", value: "Added by you" }, ...(item.version ? [{ label: "Version", value: item.version }] : [])],
    permissions: mcpPermissions(item),
  };
}

export interface ExploreEntry {
  key: string; ref: PluginRef; name: string; description: string; logo?: string; verified: boolean; category: string; kindLabel: "MCP server" | "Tool plugin";
  /** Registry plugin that can be installed from the list. */
  installable: boolean; added: boolean;
}
export const INSTALLED_CATEGORY = "Installed";
export const REGISTRY_CATEGORY = "Registry";
const CATEGORY_ORDER = ["Code", "Security", "Issues", "Cloud", "Messaging", REGISTRY_CATEGORY, INSTALLED_CATEGORY];
export const EXPLORE_PAGE_SIZE = 40;

/** One entry per thing you can open: built-in connectors keep their catalog category, registry plugins sit under "Registry", and anything you brought yourself (custom MCP servers, GitHub or local plugins) under "Installed". Nothing is invented: verified means a registry signature or a built-in connector. */
export function buildExploreEntries(input: { plugins: readonly PluginItem[]; services: readonly ServiceLike[]; mcp: readonly McpServerEntry[] }): ExploreEntry[] {
  const services = input.services.map((item): ExploreEntry => ({ key: `service:${item.id}`, ref: { kind: "service", id: item.id }, name: item.name, description: clean(item.description), logo: safeLogo(item.logo), verified: true, category: clean(item.category) || "Other", kindLabel: "MCP server", installable: false, added: item.configured && item.enabled && !item.error }));
  const custom = input.mcp.map((item): ExploreEntry => ({ key: `mcp:${item.id}`, ref: { kind: "mcp", id: item.id }, name: item.name, description: item.transport === "stdio" ? "Command-line MCP server you added" : `Remote MCP server${item.url ? ` at ${hostOf(item.url)}` : ""}`, logo: safeLogo(item.logo), verified: false, category: INSTALLED_CATEGORY, kindLabel: "MCP server", installable: false, added: item.enabled }));
  const plugins = input.plugins.filter(item => item.kind === "plugin").map((item): ExploreEntry => {
    const own = item.source === "github" || item.source === "local";
    return { key: `plugin:${item.id}`, ref: { kind: "plugin", id: item.id }, name: item.name, description: cleanDescription(item) || countLabel(item.capabilities.length, "permission"), logo: safeLogo(item.logo), verified: item.signature === "verified", category: own ? INSTALLED_CATEGORY : REGISTRY_CATEGORY, kindLabel: "Tool plugin", installable: item.state === "available" && !own, added: item.state === "enabled" };
  });
  return [...services, ...plugins, ...custom];
}

export interface ExploreSection { category: string; entries: ExploreEntry[] }
const categoryRank = (category: string) => { const index = CATEGORY_ORDER.indexOf(category); return index < 0 ? CATEGORY_ORDER.length - 2 : index; };
/** Search matches name, description and category; sections keep a stable order and each section is sorted by name. */
export function exploreSections(entries: readonly ExploreEntry[], query = "", category = ""): ExploreSection[] {
  const needle = query.trim().toLowerCase();
  const map = new Map<string, ExploreEntry[]>();
  for (const entry of entries) {
    if (category && entry.category !== category) continue;
    if (needle && !`${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(needle)) continue;
    map.set(entry.category, [...(map.get(entry.category) ?? []), entry]);
  }
  return [...map.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0])).map(([name, list]) => ({ category: name, entries: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}
export const exploreCategories = (entries: readonly ExploreEntry[]) => exploreSections(entries).map(section => section.category);

/** 1-based page; `pages` is 1 when the list fits, so pagination controls render only past `size` rows. */
export function paginate<T>(items: readonly T[], page: number, size = EXPLORE_PAGE_SIZE): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: items.slice((at - 1) * size, at * size), page: at, pages };
}
