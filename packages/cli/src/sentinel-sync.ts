/**
 * Sentinels defined as files in a git repository. Each `*.yaml` file in a folder is one Sentinel: its charter, skills, model and the
 * automations with their triggers. `plan` says what would change; `apply` makes the database match.
 *
 * Nothing here switches anything on. A new Sentinel is created paused, a trigger is created disabled (enable it after review, or pass
 * `enable` when the change was already reviewed as a pull request), and a changed model or skill list sends the Sentinel back to
 * "needs review" through the same fingerprint check as an edit in the app.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { SentinelGithubPrConfigSchema, SentinelScheduleSchema, createSecurityWorkflowTemplate, type Sentinel } from "@0/engine/shared";
import type { SecurityWorkflowStore, SentinelStore } from "@0/engine/storage";

const MAX_FILES = 50;
const MAX_FILE_BYTES = 256 * 1024;
const SYNC_FILE = "source.json";

const TriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({ kind: z.literal("schedule"), schedule: SentinelScheduleSchema }),
  z.strictObject({ kind: z.literal("github-pr"), github: SentinelGithubPrConfigSchema }),
]);
const AutomationSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  template: z.string().trim().min(1).max(100),
  runIn: z.enum(["new-mission", "sentinel-home"]).optional(),
  target: z.string().trim().min(1).max(500).optional(),
  triggers: z.array(TriggerSchema).max(10).default([]),
});
export const SentinelDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  mission: z.string().trim().max(160).optional(),
  instructions: z.string().max(65_536).optional(),
  skills: z.array(z.string().trim().min(1).max(384)).max(64).optional(),
  model: z.strictObject({ providerId: z.string().trim().min(1).max(128), model: z.string().trim().min(1).max(256), reasoning: z.string().trim().min(1).max(32).optional() }).nullable().optional(),
  folder: z.string().trim().min(1).max(4096).nullable().optional(),
  automations: z.array(AutomationSchema).max(20).default([]),
});
export type SentinelDefinition = z.output<typeof SentinelDefinitionSchema>;
export interface LoadedDefinition { file: string; definition: SentinelDefinition }

/** Read every `.yaml` / `.yml` file in a folder. Throws one error naming each file that is not a valid definition. */
export function loadDefinitions(folder: string): LoadedDefinition[] {
  const names = readdirSync(folder).filter(name => /\.ya?ml$/i.test(extname(name))).sort();
  if (names.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} definition files in ${folder}.`);
  const problems: string[] = [];
  const loaded: LoadedDefinition[] = [];
  for (const name of names) {
    const path = join(folder, name);
    try {
      if (statSync(path).size > MAX_FILE_BYTES) throw new Error("larger than 256 KB");
      // Plain YAML only: no custom tags, no merge keys, no aliases that could multiply content.
      const document = parseDocument(readFileSync(path, "utf8"), { schema: "core", merge: false });
      const problem = [...document.errors, ...document.warnings][0];
      if (problem) throw new Error(problem.message.split("\n")[0]!);
      const raw = document.toJS({ maxAliasCount: 0 });
      const parsed = SentinelDefinitionSchema.safeParse(raw);
      if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; "));
      loaded.push({ file: name, definition: parsed.data });
    } catch (error) { problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const seen = new Set<string>();
  for (const { file, definition } of loaded) {
    if (seen.has(definition.name)) problems.push(`${file}: the name "${definition.name}" is used by another file`);
    seen.add(definition.name);
  }
  if (problems.length) throw new Error(`Invalid definitions:\n${problems.map(problem => `  ${problem}`).join("\n")}`);
  return loaded;
}

export interface SyncChange { sentinel: string; action: "create" | "update" | "unchanged"; changes: string[] }
export interface SyncStores { sentinels: SentinelStore; workflows: SecurityWorkflowStore }

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : item);
const triggerShape = (trigger: { kind: string; schedule?: unknown; github?: unknown }) => canonical({ kind: trigger.kind, ...(trigger.schedule ? { schedule: trigger.schedule } : {}), ...(trigger.github ? { github: trigger.github } : {}) });

function diffSentinel(current: Sentinel, instructions: string | undefined, charter: string | undefined, definition: SentinelDefinition): string[] {
  const changes: string[] = [];
  if (definition.mission !== undefined && definition.mission !== current.mission) changes.push("mission");
  if (definition.skills !== undefined && canonical(definition.skills) !== canonical(current.skills)) changes.push("skills");
  if (definition.model !== undefined && canonical(definition.model) !== canonical(current.model)) changes.push("model");
  if (definition.folder !== undefined && definition.folder !== current.folder) changes.push("folder");
  if (instructions !== undefined && instructions.trim() !== (charter ?? "").trim()) changes.push("instructions");
  return changes;
}

/** Compare the definitions with the database and write nothing. */
export function planSync(definitions: LoadedDefinition[], stores: SyncStores): SyncChange[] {
  const existing = stores.sentinels.list();
  return definitions.map(({ definition }) => {
    const current = existing.find(sentinel => sentinel.name === definition.name && sentinel.status !== "archived");
    if (!current) return { sentinel: definition.name, action: "create" as const, changes: ["new Sentinel (paused)", ...definition.automations.map(automation => `automation ${automation.name}`)] };
    const changes = diffSentinel(current, definition.instructions, stores.sentinels.getFile(current.id, "AGENTS.md")?.content, definition);
    const owned = stores.workflows.list().filter(workflow => workflow.ownerSentinelId === current.id);
    for (const automation of definition.automations) {
      const workflow = owned.find(candidate => candidate.name === automation.name);
      if (!workflow) { changes.push(`automation ${automation.name}`); continue; }
      const have = stores.sentinels.listTriggers(current.id).filter(trigger => trigger.automationId === workflow.id).map(triggerShape).sort();
      const want = automation.triggers.map(triggerShape).sort();
      if (canonical(have) !== canonical(want)) changes.push(`triggers of ${automation.name}`);
    }
    return { sentinel: definition.name, action: changes.length ? "update" as const : "unchanged" as const, changes };
  });
}

export interface ApplyOptions {
  /** Commit the definitions came from; recorded on the Sentinel so a reader can see what is live. */
  commit?: string;
  /** Enable the triggers this sync creates. Only for a change that was already reviewed. */
  enable?: boolean;
  actor?: string;
}

/** Make the database match the definitions. A Sentinel that is not in the folder is left alone. */
export function applySync(definitions: LoadedDefinition[], stores: SyncStores, options: ApplyOptions = {}): SyncChange[] {
  const actor = options.actor ?? "sync";
  const plan = planSync(definitions, stores);
  definitions.forEach(({ file, definition }, index) => {
    if (plan[index]!.action === "unchanged") return;
    const body = {
      name: definition.name,
      ...(definition.mission !== undefined ? { mission: definition.mission } : {}),
      ...(definition.skills !== undefined ? { skills: definition.skills } : {}),
      ...(definition.model !== undefined ? { model: definition.model } : {}),
      ...(definition.folder !== undefined ? { folder: definition.folder } : {}),
    };
    let sentinel = stores.sentinels.list().find(candidate => candidate.name === definition.name && candidate.status !== "archived");
    if (!sentinel) {
      sentinel = stores.sentinels.create({ ...body, ...(definition.instructions !== undefined ? { instructions: definition.instructions } : {}) }, actor);
      // The charter is exactly the file's text, so the next comparison is a plain equality.
      const seeded = stores.sentinels.getFile(sentinel.id, "AGENTS.md");
      if (definition.instructions !== undefined && seeded) stores.sentinels.putFile(sentinel.id, "AGENTS.md", definition.instructions, seeded.revision, "human", actor);
    } else {
      const { name: _name, ...fields } = body;
      if (Object.keys(fields).length) sentinel = stores.sentinels.update(sentinel.id, { version: sentinel.version, ...fields });
      const charter = stores.sentinels.getFile(sentinel.id, "AGENTS.md");
      if (definition.instructions !== undefined && definition.instructions.trim() !== (charter?.content ?? "").trim()) {
        stores.sentinels.putFile(sentinel.id, "AGENTS.md", definition.instructions, charter?.revision ?? null, "human", actor);
      }
    }
    for (const automation of definition.automations) {
      const owned = stores.workflows.list().filter(workflow => workflow.ownerSentinelId === sentinel!.id);
      let workflow = owned.find(candidate => candidate.name === automation.name);
      if (!workflow) {
        workflow = stores.workflows.save({ ...createSecurityWorkflowTemplate(automation.template, { target: automation.target ?? "." }), name: automation.name, ownerSentinelId: sentinel.id, runIn: automation.runIn ?? "new-mission" });
      }
      const have = stores.sentinels.listTriggers(sentinel.id).filter(trigger => trigger.automationId === workflow!.id);
      const want = new Map(automation.triggers.map(trigger => [triggerShape(trigger), trigger]));
      for (const trigger of have) {
        if (want.has(triggerShape(trigger))) want.delete(triggerShape(trigger));
        else stores.sentinels.deleteTrigger(trigger.id);
      }
      for (const trigger of want.values()) stores.sentinels.createTrigger(sentinel.id, { automationId: workflow.id, ...trigger, enabled: options.enable === true });
    }
    const source = stores.sentinels.getFile(sentinel.id, SYNC_FILE);
    stores.sentinels.putFile(sentinel.id, SYNC_FILE, `${JSON.stringify({ file, ...(options.commit ? { commit: options.commit } : {}), syncedAt: new Date().toISOString() }, null, 2)}\n`, source?.revision ?? null, "human", actor);
  });
  return plan;
}

/** A Sentinel as a definition file, so a team can start from what it already has. */
export function exportDefinition(sentinel: Sentinel, stores: SyncStores): string {
  const owned = stores.workflows.list().filter(workflow => workflow.ownerSentinelId === sentinel.id);
  const triggers = stores.sentinels.listTriggers(sentinel.id);
  const definition: SentinelDefinition = {
    name: sentinel.name, ...(sentinel.mission ? { mission: sentinel.mission } : {}),
    instructions: stores.sentinels.getFile(sentinel.id, "AGENTS.md")?.content ?? "",
    skills: sentinel.skills, ...(sentinel.model ? { model: sentinel.model } : {}), ...(sentinel.folder ? { folder: sentinel.folder } : {}),
    automations: owned.flatMap(workflow => {
      const template = (workflow as { template?: { id?: string } }).template?.id;
      if (!template) return [];
      return [{ name: workflow.name, template, ...(workflow.runIn ? { runIn: workflow.runIn as "new-mission" | "sentinel-home" } : {}), ...((workflow as { target?: string }).target ? { target: (workflow as { target?: string }).target! } : {}),
        triggers: triggers.filter(trigger => trigger.automationId === workflow.id).map(trigger => TriggerSchema.parse({ kind: trigger.kind, ...(trigger.schedule ? { schedule: trigger.schedule } : {}), ...(trigger.github ? { github: trigger.github } : {}) })) }];
    }),
  };
  return stringify(definition, { lineWidth: 100 });
}
