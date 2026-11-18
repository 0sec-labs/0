/**
 * What the Extensions page shows: one row per built-in and installed extension, with what it can do, where it came
 * from and whether it may run. A read-only view over the store and `loadable()`; it changes nothing.
 */
import { BUILTIN_EXTENSIONS } from "./core/builtins.js";
import { canDoLines, capabilitiesOf } from "./core/capabilities.js";
import type { ConnectorDecl } from "./core/connector.js";
import { parseManifest } from "./core/manifest.js";
import type { ImportReport } from "./core/state.js";
import type { ExtensionStore } from "./ports.js";
import type { McpObservationLog, McpPinStore } from "./mcp/ports.js";
import { mcpServerStatuses, type McpServerStatus } from "./mcp/status.js";
import { listRows, loadable, type ListRow, type RefusalCode } from "./runtime.js";
import { readVerified } from "./verify.js";

export interface ExtensionOverviewRow {
  name: string; builtin: boolean; kind: ListRow["kind"]; version: string; description: string;
  /** `refused` means it is switched on but will not run (tampered, capabilities changed, not approved, unmigrated). */
  status: ListRow["status"] | "refused";
  enabled: boolean;
  /** Full commit for git sources, `local-<hash>` for folders, null for built-ins. */
  revision: string | null;
  /** `owner/repo` or the folder path; null for built-ins. */
  sourceLabel: string | null;
  /** What it can do, one plain line each. */
  canDo: string[];
  skills: string[];
  /** The connector contract it declares (what it reads and writes, how it connects), when it is a connector. */
  connector: ConnectorDecl | null;
  refusal: { code: RefusalCode; reason: string } | null;
  /** MCP servers the extension declares: approved tool hashes against what each last showed (Changed / New / Removed). */
  mcp: McpServerStatus[];
  note: string;
  /** Built-ins only: when the page must not offer an on/off switch. */
  required: "always" | null;
}
export interface ExtensionOverview {
  rows: ExtensionOverviewRow[]; importReport: ImportReport | null; error?: string;
}

const sourceLabel = (source: { type: "git"; url: string } | { type: "local"; path: string } | null): string | null =>
  !source ? null : source.type === "local" ? source.path : source.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

export function extensionOverview(store: ExtensionStore, projectKey: string | null, mcp?: { pins: McpPinStore; observed: McpObservationLog } ): ExtensionOverview {
  const state = store.read(); if (!state.ok) return { rows: [], importReport: null, error: state.error.message };
  const listed = listRows(store, projectKey);
  const refused = new Map(loadable(store, projectKey).refused.map(r => [r.name, r]));
  const rows = listed.rows.map((row): ExtensionOverviewRow => {
    const builtin = BUILTIN_EXTENSIONS.find(b => b.name === row.name);
    const entry = row.kind === "built-in" ? undefined : state.value.extensions[row.name];
    let canDo: string[] = builtin ? [...builtin.canDo] : []; let skills: string[] = [...(builtin?.skills ?? [])]; let connector: ConnectorDecl | null = builtin?.connector ?? null; let servers: McpServerStatus[] = []; let description = builtin?.description ?? row.detail;
    if (entry && !entry.legacy && entry.active) {
      const files = readVerified(store, entry, entry.active);
      const manifest = files.ok ? parseManifest(files.value, { fallbackName: entry.name }) : null;
      if (manifest?.ok) { const caps = capabilitiesOf(manifest.value); canDo = canDoLines(caps); skills = caps.skills; if (mcp && entry.active) servers = mcpServerStatuses(manifest.value, mcp.pins.pins(entry.name, entry.active), mcp.observed.read(entry.name, entry.active)); connector = manifest.value.connector; description = manifest.value.description || description; }
    }
    const refusal = refused.get(row.name) ?? null;
    return {
      name: row.name, builtin: row.kind === "built-in", kind: row.kind, version: row.version, description, status: refusal && row.status !== "unmigrated" ? "refused" : row.status,
      enabled: row.enabled, revision: row.revision, sourceLabel: sourceLabel(entry?.source ?? null), canDo, skills, connector, refusal: refusal ? { code: refusal.code, reason: refusal.reason } : null, mcp: servers,
      note: row.kind === "built-in" ? "" : row.detail, required: builtin?.required ?? null,
    };
  });
  return { rows, importReport: state.value.import };
}
