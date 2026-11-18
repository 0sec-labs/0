/**
 * Pure planner: old-store data in, new entries plus a report out. No I/O, so every mapping is unit-testable.
 * Nothing is deleted or rewritten in the old stores; entries that cannot run are listed, kept and never loaded.
 */
import { capabilitiesOf, capabilityKey } from "../core/capabilities.js";
import { getBuiltin } from "../core/builtins.js";
import { gitTreeHash, type FolderFile } from "../core/files.js";
import { isExtensionName, parseManifest, sanitizeName } from "../core/manifest.js";
import { newEntry, type ExtensionEntry, type ImportReportItem } from "../core/state.js";
import type { LegacyData, LegacyMcp } from "./legacy-reader.js";
import { redactArgs, redactUrl } from "./redact.js";
import { connectorFolder, tokenConnectorOf } from "./connector-folder.js";

export interface PlannedEntry { entry: ExtensionEntry; revision?: { id: string; files: FolderFile[]; treeHash: string } }
export interface ImportPlan { entries: PlannedEntry[]; migrated: ImportReportItem[]; notMigrated: ImportReportItem[]; notes: string[] }

const text = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n");
const file = (path: string, v: unknown): FolderFile => { const bytes = text(v); return { path, size: bytes.length, executable: false, bytes }; };

/**
 * A local extension folder holding one `.mcp.json`. Secret values are NEVER copied: env and header values become `${NAME}`
 * placeholders, and secret-looking url query keys, `user:pass@` and args (`--token x`) are redacted the same way. Every
 * placeholder name is declared under `env`, so the approval shows the names and the value comes from the environment.
 */
export function mcpFolder(name: string, s: LegacyMcp): FolderFile[] {
  const url = s.url ? redactUrl(s.url) : null; const args = redactArgs(s.args);
  const extra = [...(url?.names ?? []), ...args.names];
  const envNames = [...new Set([...s.envNames, ...extra])].sort();
  const def = s.url
    ? { type: s.transport === "sse" ? "sse" : "http", url: url!.value, headers: Object.fromEntries(s.headerNames.map(h => [h, `\${${h}}`])), ...(args.names.length ? { args: args.value } : {}), ...(extra.length ? { env: Object.fromEntries(envNames.map(n => [n, `\${${n}}`])) } : {}) }
    : { command: s.command ?? "", args: args.value, env: Object.fromEntries(envNames.map(n => [n, `\${${n}}`])) };
  return [file("extension.json", { name, version: "0.0.0", description: `Imported MCP server ${s.name}` }), file(".mcp.json", { mcpServers: { [sanitizeName(s.name) || name]: def } })];
}

/** Plain text only: a SKILL.md folder with no script, no executable bit, no environment, no MCP server, no service. Safe to enable without a prompt. */
export const isPlainSkill = (c: ReturnType<typeof capabilitiesOf>): boolean =>
  c.runs.length === 0 && c.env.length === 0 && c.mcp.length === 0 && c.service === null && c.verify === null && c.bins.length === 0 && c.ignored.length === 0;

/** `existing`: import keys already recorded by an earlier run (key -> entry name), so a forced re-run adds nothing twice. */
export function planImport(data: LegacyData, taken: ReadonlySet<string>, now: string, existing: ReadonlyMap<string, string> = new Map()): ImportPlan {
  const plan: ImportPlan = { entries: [], migrated: [], notMigrated: [], notes: [] };
  const used = new Set(taken);
  const claim = (wanted: string, prefix: string): string => {
    let name = sanitizeName(wanted); if (!isExtensionName(name)) name = sanitizeName(`${prefix}-${wanted}`);
    if (getBuiltin(name) || used.has(name)) name = sanitizeName(`${prefix}-${name}`);
    for (let i = 2; used.has(name); i++) name = sanitizeName(`${prefix}-${wanted}-${i}`);
    used.add(name); return name;
  };
  /** True (after noting it) when this item was imported by an earlier run. */
  const already = (key: string, kind: string, label: string): boolean => {
    const name = existing.get(key); if (name === undefined) return false;
    plan.migrated.push({ kind, name, detail: `${label}: already imported earlier; left as it is` }); return true;
  };
  const enabledIn = (id: string) => data.enablement.filter(e => e.ids.includes(id)).map(e => e.project);

  for (const p of data.plugins) {
    if (already(`plugins:${p.id}`, "plugin", p.id)) continue;
    const name = claim(p.id, "legacy"); const entry = newEntry(name, null); entry.importKey = `plugins:${p.id}`;
    entry.legacy = { kind: p.source ? "executable-github" : "executable-other", dir: p.dir, ...(p.source ? { repo: p.source.repo, ref: p.source.ref, sha: p.source.sha, ...(p.source.permissionHash ? { permissionHash: p.source.permissionHash } : {}) } : {}), approvedCapabilities: p.capabilities, enabledIn: enabledIn(p.id), reason: "executable tools (plugin.js): re-express as scripts or an MCP server" };
    entry.importedFrom = "plugins"; plan.entries.push({ entry });
    plan.notMigrated.push({ kind: p.source ? "github-plugin" : "plugin", name, detail: `executable tools cannot run; kept disabled${p.source ? ` with source ${p.source.repo}@${p.source.sha.slice(0, 12)} and its recorded approval` : ""}; files left in ${p.dir}` });
  }
  for (const a of data.authored) {
    if (already(`executable-plugins:${a.id}`, "model-authored", a.id)) continue;
    const name = claim(a.id, "authored"); const entry = newEntry(name, null); entry.importKey = `executable-plugins:${a.id}`;
    entry.legacy = { kind: "model-authored", dir: a.dir, reason: "model-authored executable plugin: write a skill or extension folder and install it through the normal prompt" };
    entry.importedFrom = "executable-plugins"; plan.entries.push({ entry });
    plan.notMigrated.push({ kind: "model-authored", name, detail: `${a.kind} ${a.name}: reported only; files left in place in ${a.dir}` });
  }
  for (const s of data.mcp) {
    if (already(`mcp-servers:${s.id}`, "mcp-server", s.name || s.id)) continue;
    const name = claim(s.name || s.id, "mcp"); const files = mcpFolder(name, s); const treeHash = gitTreeHash(files); const revision = `local-${treeHash.slice(0, 16)}`;
    const manifest = parseManifest(files, { fallbackName: name });
    if (!manifest.ok) { plan.notMigrated.push({ kind: "mcp-server", name: s.name, detail: manifest.error.message }); continue; }
    const entry = newEntry(name, null); entry.importKey = `mcp-servers:${s.id}`;
    entry.active = revision; entry.enabled.global = s.enabled; entry.importedFrom = "mcp-servers"; entry.note = "imported MCP server: re-approve before first use; secret values stay in the old mcp-servers.json";
    entry.revisions[revision] = { version: "0.0.0", format: manifest.value.format, treeHash, installedAt: now, location: { kind: "store" }, approvedAt: null, approvedCapabilities: null, approvedCapabilityKey: null, approvedEnv: [] };
    plan.entries.push({ entry, revision: { id: revision, files, treeHash } });
    plan.migrated.push({ kind: "mcp-server", name, detail: `imported as a local extension${s.enabled ? " (was enabled)" : ""}; needs re-approval` });
  }
  for (const s of data.services) {
    if (s.id === "github") { plan.migrated.push({ kind: "connection", name: "github", detail: "kept: the built-in github extension uses the existing connection and token" }); continue; }
    const token = tokenConnectorOf(s.id);
    if (!token) { plan.notMigrated.push({ kind: "connection", name: s.id, detail: "needs more than a token (a URL or identifiers): reported only; the stored credentials are untouched" }); continue; }
    if (already(`service-plugins:${s.id}`, "connection", s.id)) continue;
    const name = claim(s.id, "connector"); const files = connectorFolder(name, token); const treeHash = gitTreeHash(files); const revision = `local-${treeHash.slice(0, 16)}`;
    const manifest = parseManifest(files, { fallbackName: name });
    if (!manifest.ok) { plan.notMigrated.push({ kind: "connection", name: s.id, detail: manifest.error.message }); continue; }
    const entry = newEntry(name, null); entry.importKey = `service-plugins:${s.id}`;
    entry.active = revision; entry.enabled.global = s.enabled; entry.importedFrom = "service-plugins";
    entry.note = `imported connection: connect it again to fill ${token.env}; the old token stays in service-plugins.json and its tools keep working there`;
    entry.revisions[revision] = { version: "0.0.0", format: manifest.value.format, treeHash, installedAt: now, location: { kind: "store" }, approvedAt: null, approvedCapabilities: null, approvedCapabilityKey: null, approvedEnv: [] };
    plan.entries.push({ entry, revision: { id: revision, files, treeHash } });
    plan.migrated.push({ kind: "connection", name, detail: `imported as a token connector extension${s.enabled ? " (was enabled)" : ""}; needs approval; the token itself was not copied` });
  }
  for (const s of data.skills) {
    if (already(`skills-library:${s.name}`, "skill", s.name)) continue;
    const manifest = parseManifest(s.files, { fallbackName: s.name });
    if (!manifest.ok) { plan.notMigrated.push({ kind: "skill", name: s.name, detail: manifest.error.message }); continue; }
    const name = claim(s.name, "skill"); const entry = newEntry(name, null); entry.importKey = `skills-library:${s.name}`; const caps = capabilitiesOf(manifest.value);
    const revision = s.origin ? s.origin.sha : `local-${s.treeHash.slice(0, 16)}`;
    // owner/repo/path skills record the subpath so an update reads that folder, not the repository root.
    if (s.origin) entry.source = { type: "git", url: `https://github.com/${s.origin.repo}.git`, ...(s.origin.path ? { subpath: s.origin.path } : {}) };
    // Plain text is enabled with no environment. Anything that can run, or asks for environment, comes in disabled and unapproved.
    const plain = isPlainSkill(caps);
    entry.active = revision; entry.approvedRevision = plain ? revision : null; entry.enabled.global = plain; entry.importedFrom = "skills-library";
    const where = s.origin ? `${s.origin.repo}${s.origin.path ? `/${s.origin.path}` : ""} at ${s.origin.sha.slice(0, 12)}` : "";
    entry.note = (s.origin ? `adopted in place from ${where}; files stay in the skills library` : "custom skill adopted in place; files stay in the skills library") + (plain ? "" : "; has scripts or environment: review and approve before it is enabled");
    entry.revisions[revision] = { version: manifest.value.version, format: manifest.value.format, treeHash: s.treeHash, installedAt: s.origin?.installedAt || now, location: { kind: "external", path: s.dir },
      approvedAt: plain ? now : null, approvedCapabilities: plain ? caps : null, approvedCapabilityKey: plain ? capabilityKey(caps) : null, approvedEnv: [] };
    plan.entries.push({ entry });
    plan.migrated.push({ kind: s.origin ? "github-skill" : "skill", name, detail: plain ? (s.origin ? `${s.origin.repo}@${s.origin.sha.slice(0, 12)} pin kept; text-only, enabled` : "kept as a text-only skill, enabled") : "imported but disabled: it has scripts or environment and needs approval" });
  }
  if (data.problems.length) plan.notes.push(...data.problems.map(p => `could not read: ${p}`));
  plan.notes.push("Project, user, linked and built-in skills stay where they are and keep loading as before.");
  plan.notes.push("Nothing in the old stores was changed or deleted.");
  return plan;
}
