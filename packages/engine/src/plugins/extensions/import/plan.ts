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

export interface PlannedEntry { entry: ExtensionEntry; revision?: { id: string; files: FolderFile[]; treeHash: string } }
export interface ImportPlan { entries: PlannedEntry[]; migrated: ImportReportItem[]; notMigrated: ImportReportItem[]; notes: string[] }

const text = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n");
const file = (path: string, v: unknown): FolderFile => { const bytes = text(v); return { path, size: bytes.length, executable: false, bytes }; };

/** A local extension folder holding one `.mcp.json`. Secret values are NEVER copied: env and header values become `${NAME}` placeholders. */
export function mcpFolder(name: string, s: LegacyMcp): FolderFile[] {
  const def = s.url
    ? { type: s.transport === "sse" ? "sse" : "http", url: s.url, headers: Object.fromEntries(s.headerNames.map(h => [h, `\${${h}}`])) }
    : { command: s.command ?? "", args: s.args, env: Object.fromEntries(s.envNames.map(n => [n, `\${${n}}`])) };
  return [file("extension.json", { name, version: "0.0.0", description: `Imported MCP server ${s.name}` }), file(".mcp.json", { mcpServers: { [sanitizeName(s.name) || name]: def } })];
}

export function planImport(data: LegacyData, taken: ReadonlySet<string>, now: string): ImportPlan {
  const plan: ImportPlan = { entries: [], migrated: [], notMigrated: [], notes: [] };
  const used = new Set(taken);
  const claim = (wanted: string, prefix: string): string => {
    let name = sanitizeName(wanted); if (!isExtensionName(name)) name = sanitizeName(`${prefix}-${wanted}`);
    if (getBuiltin(name) || used.has(name)) name = sanitizeName(`${prefix}-${name}`);
    for (let i = 2; used.has(name); i++) name = sanitizeName(`${prefix}-${wanted}-${i}`);
    used.add(name); return name;
  };
  const enabledIn = (id: string) => data.enablement.filter(e => e.ids.includes(id)).map(e => e.project);

  for (const p of data.plugins) {
    const name = claim(p.id, "legacy"); const entry = newEntry(name, null);
    entry.legacy = { kind: p.source ? "executable-github" : "executable-other", dir: p.dir, ...(p.source ? { repo: p.source.repo, ref: p.source.ref, sha: p.source.sha, ...(p.source.permissionHash ? { permissionHash: p.source.permissionHash } : {}) } : {}), approvedCapabilities: p.capabilities, enabledIn: enabledIn(p.id), reason: "executable tools (plugin.js): re-express as scripts or an MCP server" };
    entry.importedFrom = "plugins"; plan.entries.push({ entry });
    plan.notMigrated.push({ kind: p.source ? "github-plugin" : "plugin", name, detail: `executable tools cannot run; kept disabled${p.source ? ` with source ${p.source.repo}@${p.source.sha.slice(0, 12)} and its recorded approval` : ""}; files left in ${p.dir}` });
  }
  for (const a of data.authored) {
    const name = claim(a.id, "authored"); const entry = newEntry(name, null);
    entry.legacy = { kind: "model-authored", dir: a.dir, reason: "model-authored executable plugin: write a skill or extension folder and install it through the normal prompt" };
    entry.importedFrom = "executable-plugins"; plan.entries.push({ entry });
    plan.notMigrated.push({ kind: "model-authored", name, detail: `${a.kind} ${a.name}: reported only; files left in place in ${a.dir}` });
  }
  for (const s of data.mcp) {
    const name = claim(s.name || s.id, "mcp"); const files = mcpFolder(name, s); const treeHash = gitTreeHash(files); const revision = `local-${treeHash.slice(0, 16)}`;
    const manifest = parseManifest(files, { fallbackName: name });
    if (!manifest.ok) { plan.notMigrated.push({ kind: "mcp-server", name: s.name, detail: manifest.error.message }); continue; }
    const entry = newEntry(name, null);
    entry.active = revision; entry.enabled.global = s.enabled; entry.importedFrom = "mcp-servers"; entry.note = "imported MCP server: re-approve before first use; secret values stay in the old mcp-servers.json";
    entry.revisions[revision] = { version: "0.0.0", format: manifest.value.format, treeHash, installedAt: now, location: { kind: "store" }, approvedAt: null, approvedCapabilities: null, approvedCapabilityKey: null, approvedEnv: [] };
    plan.entries.push({ entry, revision: { id: revision, files, treeHash } });
    plan.migrated.push({ kind: "mcp-server", name, detail: `imported as a local extension${s.enabled ? " (was enabled)" : ""}; needs re-approval` });
  }
  for (const s of data.services) {
    if (s.id === "github") plan.migrated.push({ kind: "connection", name: "github", detail: "kept: the built-in github extension uses the existing connection and token" });
    else plan.notMigrated.push({ kind: "connection", name: s.id, detail: "connector extension not yet available; the stored token is untouched" });
  }
  for (const s of data.skills) {
    const manifest = parseManifest(s.files, { fallbackName: s.name });
    if (!manifest.ok) { plan.notMigrated.push({ kind: "skill", name: s.name, detail: manifest.error.message }); continue; }
    const name = claim(s.name, "skill"); const entry = newEntry(name, null); const caps = capabilitiesOf(manifest.value);
    const github = s.origin && !s.origin.path ? s.origin : null;
    const revision = s.origin ? s.origin.sha : `local-${s.treeHash.slice(0, 16)}`;
    if (github) entry.source = { type: "git", url: `https://github.com/${github.repo}.git` };
    entry.active = revision; entry.approvedRevision = revision; entry.enabled.global = true; entry.importedFrom = "skills-library";
    entry.note = s.origin ? `adopted in place from ${s.origin.repo}${s.origin.path ? `/${s.origin.path}` : ""} at ${s.origin.sha.slice(0, 12)}; files stay in the skills library` : "custom skill adopted in place; files stay in the skills library";
    entry.revisions[revision] = { version: manifest.value.version, format: manifest.value.format, treeHash: s.treeHash, installedAt: s.origin?.installedAt || now, location: { kind: "external", path: s.dir }, approvedAt: s.origin?.installedAt || now, approvedCapabilities: caps, approvedCapabilityKey: capabilityKey(caps), approvedEnv: caps.env };
    plan.entries.push({ entry });
    plan.migrated.push({ kind: s.origin ? "github-skill" : "skill", name, detail: s.origin ? `${s.origin.repo}@${s.origin.sha.slice(0, 12)} pin and approval carried over` : "kept as a skills-only extension" });
  }
  if (data.problems.length) plan.notes.push(...data.problems.map(p => `could not read: ${p}`));
  plan.notes.push("Project, user, linked and built-in skills stay where they are and keep loading as before.");
  plan.notes.push("Nothing in the old stores was changed or deleted.");
  return plan;
}
