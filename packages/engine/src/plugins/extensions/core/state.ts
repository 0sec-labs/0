/**
 * Extension state: the shape of `~/.0/extensions/state.json` and the pure transitions on it. Approvals live here,
 * in the user's state dir, never in a repo. Transitions mutate a draft and return a Result; the store persists the
 * draft only when the result is ok.
 */
import { z } from "zod";
import { capabilityKey, type Capabilities } from "./capabilities.js";
import { err, ok, type Result } from "./result.js";
import type { SourceRecord } from "./prompt.js";
import type { InstallPrompt } from "./prompt.js";

export const STATE_SCHEMA = 1;

const sourceSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("git"), url: z.string() }), z.object({ type: z.literal("local"), path: z.string() })]);
const revisionSchema = z.object({
  version: z.string(), format: z.string(), treeHash: z.string(), installedAt: z.string(),
  location: z.discriminatedUnion("kind", [z.object({ kind: z.literal("store") }), z.object({ kind: z.literal("external"), path: z.string() })]),
  approvedAt: z.string().nullable(), approvedCapabilities: z.custom<Capabilities>().nullable(), approvedCapabilityKey: z.string().nullable(), approvedEnv: z.array(z.string()),
});
const legacySchema = z.object({
  kind: z.enum(["executable-github", "executable-other", "model-authored"]), dir: z.string().optional(), repo: z.string().optional(), ref: z.string().nullable().optional(), sha: z.string().optional(),
  permissionHash: z.string().optional(), approvedCapabilities: z.array(z.string()).optional(), enabledIn: z.array(z.string()).optional(), reason: z.string(),
});
const entrySchema = z.object({
  name: z.string(), source: sourceSchema.nullable(), active: z.string().nullable(), approvedRevision: z.string().nullable(), revisions: z.record(z.string(), revisionSchema),
  enabled: z.object({ global: z.boolean(), projects: z.array(z.string()) }), importedFrom: z.string().optional(), legacy: legacySchema.optional(), note: z.string().optional(),
});
const reportItem = z.object({ kind: z.string(), name: z.string(), detail: z.string() });
export const stateSchema = z.object({
  version: z.literal(STATE_SCHEMA), plugins: z.record(z.string(), entrySchema),
  builtins: z.record(z.string(), z.object({ enabled: z.boolean(), changedAt: z.string().optional() })),
  import: z.object({ importedAt: z.string(), migrated: z.array(reportItem), notMigrated: z.array(reportItem), notes: z.array(z.string()) }).nullable(),
});

export type RevisionRecord = z.infer<typeof revisionSchema>;
export type ExtensionEntry = z.infer<typeof entrySchema>;
export type LegacyRecord = z.infer<typeof legacySchema>;
export type ExtensionState = z.infer<typeof stateSchema>;
export type ImportReport = NonNullable<ExtensionState["import"]>;
export type ImportReportItem = z.infer<typeof reportItem>;
export type EnableScope = { scope: "global" } | { scope: "project"; project: string };

export const emptyState = (): ExtensionState => ({ version: STATE_SCHEMA, plugins: {}, builtins: {}, import: null });

export function parseState(raw: unknown): Result<ExtensionState> {
  const r = stateSchema.safeParse(raw);
  return r.success ? ok(r.data) : err("state_corrupt", "extensions/state.json has an unknown shape; fix or remove it.");
}

export const newEntry = (name: string, source: SourceRecord | null): ExtensionEntry => ({ name, source, active: null, approvedRevision: null, revisions: {}, enabled: { global: false, projects: [] } });

/** Record an approved install of `prompt.revision`; it becomes the active and last-approved revision. */
export function applyInstall(state: ExtensionState, prompt: InstallPrompt, treeHash: string, now: string, enable?: EnableScope): Result<{ replaced: string | null }> {
  const entry = state.plugins[prompt.name] ?? newEntry(prompt.name, prompt.source);
  if (entry.legacy) return err("name_taken", `${prompt.name} is an old-format extension kept by the importer; remove it first.`);
  const replaced = entry.active && entry.active !== prompt.revision ? entry.active : null;
  entry.source = prompt.source;
  entry.revisions[prompt.revision] = {
    version: prompt.version, format: prompt.format, treeHash, installedAt: now, location: { kind: "store" },
    approvedAt: now, approvedCapabilities: prompt.capabilities, approvedCapabilityKey: capabilityKey(prompt.capabilities), approvedEnv: prompt.capabilities.env,
  };
  entry.active = prompt.revision; entry.approvedRevision = prompt.revision;
  if (enable) applyScope(entry, enable, true);
  state.plugins[prompt.name] = entry;
  return ok({ replaced });
}

export function applyScope(entry: ExtensionEntry, scope: EnableScope, on: boolean, keyOf: (p: string) => string = p => p): void {
  if (scope.scope === "global") { entry.enabled.global = on; if (!on) entry.enabled.projects = []; return; }
  const key = keyOf(scope.project);
  entry.enabled.projects = entry.enabled.projects.filter(p => p !== key);
  if (on) entry.enabled.projects.push(key);
}

export const isEnabledFor = (entry: ExtensionEntry, project: string | null): boolean => entry.enabled.global || (project !== null && entry.enabled.projects.includes(project));

export type RowStatus = "enabled" | "disabled" | "needs-approval" | "unmigrated";
export function statusOf(entry: ExtensionEntry, project: string | null): RowStatus {
  if (entry.legacy) return "unmigrated";
  if (!entry.active || !entry.revisions[entry.active]?.approvedAt) return "needs-approval";
  return isEnabledFor(entry, project) ? "enabled" : "disabled";
}
