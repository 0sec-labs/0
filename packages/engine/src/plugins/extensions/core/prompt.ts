/**
 * The ONE install prompt data model. `0 skills add|extensions info|update` print it and the Extensions page
 * (step 3) renders it. It carries: repo @ full commit, what the extension can do, and the diff since the last
 * approved version. Third-party extensions never update without a new prompt.
 */
import { createHash } from "node:crypto";
import { canDoLines, capabilityDelta, capabilityKey, providerEnvNames, type Capabilities } from "./capabilities.js";
import { diffFolders, type FolderDiff } from "./diff.js";
import { hiddenUnicodeFiles, type FolderFile } from "./files.js";
import type { ExtensionManifest } from "./manifest.js";

/** `subpath`: the extension is a folder inside the repository (an `owner/repo/path` skill), so an update reads that folder. */
export type SourceRecord = { type: "git"; url: string; subpath?: string } | { type: "local"; path: string };

export interface PromptDiff extends FolderDiff { fromRevision: string; capabilityDelta: { added: string[]; removed: string[] } }

export interface InstallPrompt {
  /** Identifies this exact prompt: name, revision, source and capability digest. The approval must echo it. */
  id: string;
  kind: "install" | "update";
  name: string; version: string; description: string; format: string;
  source: SourceRecord;
  /** Full commit SHA for git sources; `local-<content hash>` for local folders. */
  revision: string;
  pinned: boolean;
  /** `repo @ full commit`: the line the approval echoes. */
  repoAtCommit: string;
  licence: string | null;
  files: Array<{ path: string; size: number }>;
  hiddenUnicode: string[];
  capabilities: Capabilities;
  canDo: string[];
  updatePolicy: "never-automatic";
  diff: PromptDiff | null;
  warnings: string[];
}

export const promptId = (p: { name: string; revision: string; source: SourceRecord; capabilities: Capabilities }): string =>
  createHash("sha256").update(JSON.stringify([p.name, p.revision, p.source, capabilityKey(p.capabilities)])).digest("hex");

export interface PromptInput {
  manifest: ExtensionManifest; capabilities: Capabilities; source: SourceRecord; revision: string; files: readonly FolderFile[];
  /** Last approved revision, when this is an update or reinstall. */
  previous: { revision: string; files: readonly FolderFile[] | null; capabilities: Capabilities | null } | null;
}

export function buildInstallPrompt(i: PromptInput): InstallPrompt {
  const warnings: string[] = [];
  const provider = providerEnvNames(i.capabilities);
  if (provider.length) warnings.push(`declares model provider credentials (${provider.join(", ")}); they are passed only if you approve this prompt`);
  if (i.source.type === "git" && i.source.url.startsWith("/")) warnings.push("installed from a local git repository");
  let diff: PromptDiff | null = null;
  if (i.previous && i.previous.revision !== i.revision) {
    if (!i.previous.files) warnings.push("the previously approved folder could not be read; everything is shown as new");
    diff = { ...diffFolders(i.previous.files ?? [], i.files), fromRevision: i.previous.revision, capabilityDelta: capabilityDelta(i.previous.capabilities, i.capabilities) };
  }
  const where = i.source.type === "git" ? i.source.url : i.source.path;
  return {
    id: promptId({ name: i.manifest.name, revision: i.revision, source: i.source, capabilities: i.capabilities }),
    kind: i.previous ? "update" : "install", name: i.manifest.name, version: i.manifest.version, description: i.manifest.description, format: i.manifest.format,
    source: i.source, revision: i.revision, pinned: i.source.type === "git", repoAtCommit: `${where} @ ${i.revision}`, licence: i.manifest.license,
    files: i.files.map(f => ({ path: f.path, size: f.size })), hiddenUnicode: hiddenUnicodeFiles(i.files), capabilities: i.capabilities, canDo: canDoLines(i.capabilities),
    updatePolicy: "never-automatic", diff, warnings,
  };
}

export function renderInstallPrompt(p: InstallPrompt): string {
  const out = [`${p.kind === "update" ? "Update" : "Install"} extension ${p.name} ${p.version}`, p.repoAtCommit + (p.pinned ? "" : "  (unpinned local folder: asks again when its content changes)")];
  if (p.description) out.push(p.description);
  out.push(`Licence: ${p.licence ?? "not declared"}   Files: ${p.files.length}   Layout: ${p.format}`, "", "It can:");
  out.push(...(p.canDo.length ? p.canDo.map(l => `  - ${l}`) : ["  - nothing beyond providing text"]));
  for (const w of p.warnings) out.push(`warning: ${w}`);
  if (p.hiddenUnicode.length) out.push(`warning: hidden Unicode characters in ${p.hiddenUnicode.join(", ")}`);
  if (p.diff) {
    const d = p.diff;
    out.push("", `Changes since the approved version ${d.fromRevision.slice(0, 12)}:`);
    for (const [label, list] of [["added", d.added], ["removed", d.removed], ["changed", d.changed]] as const) if (list.length) out.push(`  ${label}: ${list.join(", ")}`);
    if (!d.added.length && !d.removed.length && !d.changed.length) out.push("  no file changes");
    if (d.capabilityDelta.added.length || d.capabilityDelta.removed.length) {
      out.push("  capability changes:", ...d.capabilityDelta.added.map(l => `    + ${l}`), ...d.capabilityDelta.removed.map(l => `    - ${l}`));
    }
    if (d.patch) out.push("", d.patch, ...(d.patchTruncated ? ["... diff truncated"] : []));
  }
  out.push("", "Never updates automatically. Any change asks again.");
  return out.join("\n");
}
