import { createHash } from "node:crypto";
import { SecurityWorkflowStore, SentinelStore, defaultSentinelFiles } from "@0/engine/storage";
import {
  AGENT_FILE_API_VERSION, AGENT_FILE_MAX_FILES, SENTINEL_PRESETS, SentinelGithubPrConfigSchema, SentinelScheduleSchema, agentFileHash, agentFileToSentinelFields, applySentinelPatch,
  createSecurityWorkflowTemplate, getSecurityWorkflowTemplate, parseAgentFile, sentinelAccessLevel, serializeAgentFile, triggerKey,
  type AgentFile, type AgentFileIssue, type AgentFileTrigger, type Sentinel, type SentinelManagedBy, type SentinelPreset, type SentinelTrigger,
} from "@0/engine/shared";

/** One Agent file as sent to the engine: its path under the applied root and its text (and the charter file it names, when `instructions` is used). */
export interface AgentDocument { path: string; content: string; charter?: string }
export interface AgentApplyRequest {
  documents: AgentDocument[];
  /** Label of what is applied (a directory); prune only touches Agents applied from the same root. */
  root: string; prune?: boolean; dryRun?: boolean;
  /** The operator allows files that ask for Can make changes. */
  allowChanges?: boolean;
  /** Match an unmanaged Agent with the same name and take it over. */
  adopt?: boolean;
  /** Overwrite edits made in the app since the last apply. */
  force?: boolean;
}
export interface AgentFieldChange { field: string; /** What the Agent has now. */ instance?: string; /** What the file says. */ file?: string }
export interface AgentPlanItem {
  path: string; id: string; action: "create" | "adopt" | "update" | "unchanged" | "prune" | "error";
  /** Instance Agent id, when it exists. */
  agentId?: string; changes: string[]; details: AgentFieldChange[];
  /** Edited in the app since the last apply (the stored last-applied state no longer matches). */
  drift?: boolean; hash?: string; errors?: AgentFileIssue[]; warnings?: string[];
}
export interface AgentApplyResult { dryRun: boolean; root: string; hash: string; ok: boolean; items: AgentPlanItem[]; counts: { create: number; adopt: number; update: number; unchanged: number; prune: number; error: number } }

export class AgentApplyError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const shortId = (id: string): string => id.replace(/-/g, "").slice(0, 8);
const short = (value: unknown): string => { const text = typeof value === "string" ? value : stable(value) ?? "none"; return text.length > 120 ? `${text.slice(0, 117)}...` : text; };
const slugOf = (name: string): string => name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "agent";

/** Presets suggest which automation template a trigger kind starts. */
function defaultTemplate(file: AgentFile, kind: AgentFileTrigger["on"]): string {
  const preset = SENTINEL_PRESETS.find(item => item.id === file.preset);
  return preset?.suggestedAutomations.find(item => item.trigger.kind === kind && item.templateId)?.templateId ?? "repository-review";
}
const automationTarget = (file: AgentFile): string => file.scope.targets[0] ?? file.scope.domains[0] ?? file.scope.repos[0] ?? "";

interface DesiredTrigger { key: string; template: string; explicitTemplate?: string; runIn: "sentinel-home" | "new-mission"; kind: AgentFileTrigger["on"]; schedule?: unknown; github?: unknown; enabled: boolean }
function desiredTriggers(file: AgentFile): DesiredTrigger[] {
  return file.triggers.map((trigger, index) => {
    const base = { key: triggerKey(trigger, index), template: trigger.template ?? defaultTemplate(file, trigger.on), ...(trigger.template ? { explicitTemplate: trigger.template } : {}), runIn: trigger.on === "github-pr" ? "new-mission" as const : "sentinel-home" as const, kind: trigger.on, enabled: trigger.enabled };
    if (trigger.on === "schedule") { const { on: _o, id: _i, template: _t, enabled: _e, ...schedule } = trigger; return { ...base, schedule: SentinelScheduleSchema.parse(schedule) }; }
    if (trigger.on === "github-pr") { const { on: _o, id: _i, template: _t, enabled: _e, ...github } = trigger; return { ...base, github: SentinelGithubPrConfigSchema.parse(github) }; }
    return base;
  });
}

type Comparable = Pick<Sentinel, "name" | "mission" | "role" | "skills" | "scope" | "autonomy" | "toolAccess" | "budget" | "memory" | "model" | "notifications" | "avatar" | "status">;
/** The portable fields of an Agent in the words of the file; two Agents with the same view export to the same file. */
function comparable(agent: Comparable): Record<string, unknown> {
  const access = sentinelAccessLevel(agent.autonomy);
  return {
    name: agent.name, description: agent.mission, preset: agent.role, access, web: access === "read-only" && agent.toolAccess === "read-web", skills: [...agent.skills].sort(),
    scope: { repos: agent.scope.repos, targets: agent.scope.targets, domains: agent.scope.domains, outOfScope: agent.scope.outOfScope },
    budget: { dailyUsd: agent.budget.dailyUsd, maxRunsPerDay: agent.budget.maxRunsPerDay }, memory: { enabled: agent.memory.enabled, autoLearn: agent.memory.autoLearn },
    model: agent.model ? { providerId: agent.model.providerId, model: agent.model.model, reasoning: agent.model.reasoning ?? null } : null, notifications: agent.notifications,
    avatar: { color: agent.avatar.color, icon: agent.avatar.icon ?? null }, status: agent.status,
  };
}

interface TriggerRow { key: string; want: DesiredTrigger; existing?: SentinelTrigger; created: boolean; same: boolean }

export class AgentFileApplier {
  constructor(private readonly store: SentinelStore, private readonly workflows: SecurityWorkflowStore) {}

  /** Computes what applying would do; writes nothing. */
  plan(request: AgentApplyRequest): AgentApplyResult { return this.#run({ ...request, dryRun: true }); }
  /** Validates everything first and writes nothing if any file is invalid. */
  apply(request: AgentApplyRequest): AgentApplyResult { return this.#run(request); }

  /** Whether a managed Agent was edited in the app since its file was last applied. */
  isEdited(agent: Sentinel): boolean {
    const marker = agent.managedBy;
    return Boolean(marker?.stateHash) && marker!.stateHash !== this.#stateHash(agent);
  }

  #stateHash(agent: Sentinel): string {
    const charter = (this.store.getFile(agent.id, "AGENTS.md")?.content ?? "").trim();
    const triggers = Object.entries(agent.managedBy?.triggers ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, entry]) => {
      const trigger = this.store.getTrigger(entry.trigger);
      return trigger ? { key, kind: trigger.kind, enabled: trigger.enabled, schedule: trigger.schedule ?? null, github: trigger.github ?? null, template: this.workflows.get(trigger.automationId)?.template?.id ?? null } : { key, missing: true };
    });
    return createHash("sha256").update(stable({ fields: comparable(agent), charter, triggers })).digest("hex");
  }

  #run(request: AgentApplyRequest): AgentApplyResult {
    if (request.documents.length > AGENT_FILE_MAX_FILES) throw new AgentApplyError(`At most ${AGENT_FILE_MAX_FILES} Agent files can be applied at once.`);
    const items: AgentPlanItem[] = [];
    const parsed: Array<{ doc: AgentDocument; file: AgentFile; charter: string; hash: string }> = [];
    const seen = new Map<string, string>();
    const fail = (doc: AgentDocument, id: string, errors: AgentFileIssue[]) => items.push({ path: doc.path, id, action: "error", changes: [], details: [], errors });
    for (const doc of [...request.documents].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const result = parseAgentFile(doc.content);
      if (!result.ok) { fail(doc, "", result.errors); continue; }
      const { file } = result;
      let charter = result.charter;
      if (file.instructions !== undefined) {
        if (typeof doc.charter !== "string") { fail(doc, file.id, [{ message: `The charter file "${file.instructions}" was not provided.`, path: "instructions" }]); continue; }
        charter = doc.charter;
      }
      if (new TextEncoder().encode(charter).byteLength > 65_536) { fail(doc, file.id, [{ message: "The charter is larger than 64 KiB.", path: "instructions" }]); continue; }
      if (seen.has(file.id)) { fail(doc, file.id, [{ message: `The id "${file.id}" is also used by ${seen.get(file.id)}.`, path: "id" }]); continue; }
      seen.set(file.id, doc.path);
      if (file.access === "changes" && !request.allowChanges) { fail(doc, file.id, [{ message: "This file asks for access: changes. The operator has to allow that (--allow-changes, or the agents.fileAccessCeiling policy).", path: "access" }]); continue; }
      parsed.push({ doc, file, charter, hash: result.hash });
    }

    const all = this.store.list();
    const managed = new Map(all.filter(agent => agent.managedBy).map(agent => [agent.managedBy!.id, agent]));
    const unmanagedByName = new Map<string, Sentinel[]>();
    for (const agent of [...all].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))) if (!agent.managedBy) unmanagedByName.set(agent.name, [...(unmanagedByName.get(agent.name) ?? []), agent]);
    // An exported file for an Agent whose name is shared carries the Agent's short id as a suffix: that file belongs to that Agent.
    const suffixClaims = new Map<string, Sentinel>();
    for (const { file } of parsed) for (const agent of all) if (!agent.managedBy && agent.name === file.name && file.id.endsWith(`-${shortId(agent.id)}`)) suffixClaims.set(file.id, agent);
    const claimed = new Set<string>([...suffixClaims.values()].map(agent => agent.id));
    const rows: Array<{ item: AgentPlanItem; run?: () => void }> = [];
    for (const { doc, file, charter, hash } of parsed) {
      let current = managed.get(file.id);
      let adopting = false;
      if (current?.status === "archived") { items.push({ path: doc.path, id: file.id, agentId: current.id, action: "error", changes: [], details: [], errors: [{ message: "This Agent was archived in the app and cannot be resumed. Use a new id, or delete the archived Agent first.", path: "id" }] }); continue; }
      if (!current) {
        const claim = suffixClaims.get(file.id);
        const sameName = claim ? [claim] : (unmanagedByName.get(file.name) ?? []).filter(agent => !claimed.has(agent.id));
        if (sameName.length && !request.adopt) { fail(doc, file.id, [{ message: `Would create a duplicate named "${file.name}": use --adopt to take over the existing Agent, or rename it.`, path: "name" }]); continue; }
        if (sameName.length > 1 && file.id !== slugOf(file.name)) { fail(doc, file.id, [{ message: `${sameName.length} Agents are named "${file.name}"; rename one so --adopt can pick.`, path: "name" }]); continue; }
        if (sameName.length) { current = sameName[0]!; adopting = true; claimed.add(current.id); }
      }
      rows.push(current ? this.#planUpdate(current, adopting, doc, file, charter, hash, request) : this.#planCreate(doc, file, charter, hash, request.root));
    }
    items.push(...rows.map(row => row.item));

    const pruned: Sentinel[] = [];
    if (request.prune) {
      if (!parsed.length) throw new AgentApplyError("Refusing to prune: no valid Agent file was found, so every managed Agent would be removed. Check the path.", 409);
      const wanted = new Set(parsed.map(entry => entry.file.id));
      for (const agent of managed.values()) if (agent.managedBy!.root === request.root && !wanted.has(agent.managedBy!.id)) { pruned.push(agent); items.push({ path: agent.managedBy!.path, id: agent.managedBy!.id, agentId: agent.id, action: "prune", changes: [`remove "${agent.name}" and its automations`], details: [] }); }
    }

    const counts = { create: 0, adopt: 0, update: 0, unchanged: 0, prune: 0, error: 0 };
    for (const item of items) counts[item.action] += 1;
    const hash = createHash("sha256").update(request.documents.map(doc => `${doc.path}:${agentFileHash(doc.content)}`).sort().join("\n")).digest("hex");
    const result: AgentApplyResult = { dryRun: request.dryRun === true, root: request.root, hash, ok: counts.error === 0, items, counts };
    if (request.dryRun || counts.error > 0) return result;

    for (const row of rows) row.run?.();
    for (const agent of pruned) this.#remove(agent);
    return result;
  }

  #planCreate(doc: AgentDocument, file: AgentFile, charter: string, hash: string, root: string) {
    const item: AgentPlanItem = { path: doc.path, id: file.id, action: "create", changes: ["new Agent", ...(charter.trim() ? ["charter"] : []), ...file.triggers.map((t, i) => `trigger ${triggerKey(t, i)}`)], details: [], hash };
    return { item, run: () => {
      const created = this.store.create(agentFileToSentinelFields(file), "local");
      this.#writeCharter(created.id, doc.path, charter);
      this.#finish(created.id, file, { id: file.id, path: doc.path, root, hash, appliedAt: new Date().toISOString() });
      if (file.status === "active") this.store.acknowledge(created.id);
    } };
  }

  #planUpdate(current: Sentinel, adopting: boolean, doc: AgentDocument, file: AgentFile, charter: string, hash: string, request: AgentApplyRequest) {
    const fields = agentFileToSentinelFields(file);
    // Left alone when the file does not say: these are chosen in the app (or on this Computer).
    if (!file.avatar) delete fields["avatar"];
    if (!file.notifications) delete fields["notifications"];
    if (!file.model) delete fields["model"];
    if (file.avatar) fields["avatar"] = { ...current.avatar, ...(fields["avatar"] as object) };
    // A paused-by-budget Agent is not resumed by re-applying: only a person clears that.
    if (current.pauseReason && fields["status"] === "active") fields["status"] = "paused";
    const next = applySentinelPatch(current, fields);
    const before = comparable(current); const after = comparable(next);
    const details: AgentFieldChange[] = [];
    for (const key of Object.keys(before)) if (stable(before[key]) !== stable(after[key])) details.push({ field: key, instance: short(before[key]), file: short(after[key]) });
    const charterNow = this.store.getFile(current.id, "AGENTS.md")?.content ?? "";
    const charterChanged = charter.trim() !== "" && charterNow.trim() !== charter.trim();
    if (charterChanged) details.push({ field: "charter", instance: short(charterNow.trim().slice(0, 80)), file: short(charter.trim().slice(0, 80)) });
    const marker = adopting ? undefined : current.managedBy;
    const rows = this.#triggerRows(current, marker, file);
    for (const row of rows) if (!row.same) details.push({ field: `trigger ${row.key}`, instance: row.existing ? row.existing.kind : "none", file: row.want.kind });
    const known = new Set(rows.map(row => row.key));
    for (const key of Object.keys(marker?.triggers ?? {})) if (!known.has(key)) details.push({ field: `trigger ${key}`, instance: "present", file: "removed" });
    const changes = details.map(detail => detail.field);
    const edited = marker ? this.isEdited(current) : false;
    const item: AgentPlanItem = {
      path: doc.path, id: file.id, agentId: current.id, action: adopting ? "adopt" : changes.length ? "update" : "unchanged", changes, details, hash,
      ...(edited ? { drift: true } : {}), ...(current.pauseReason && file.status === "active" ? { warnings: ["Paused because of its budget; resume it in the app."] } : {}),
    };
    if (edited && changes.length && !request.force) {
      return { item: { ...item, action: "error" as const, errors: [{ message: `Edited in the app since the last apply, and the file would overwrite: ${changes.join(", ")}. Review with \`0 agents diff\`, export the Agent to keep the edits, or apply with --force.`, path: "" }] } };
    }
    const base: Omit<SentinelManagedBy, "stateHash" | "triggers"> = { id: file.id, path: doc.path, root: request.root, hash, appliedAt: new Date().toISOString() };
    // Nothing to write: same file, same place, no differences. Re-applying leaves the stored Agent byte for byte alone.
    if (marker && !changes.length && marker.path === doc.path && marker.root === request.root && marker.hash === hash && marker.stateHash && !edited) return { item };
    return { item, run: () => {
      if (details.some(detail => !detail.field.startsWith("trigger") && detail.field !== "charter")) {
        const updated = this.store.update(current.id, { ...fields, version: current.version });
        if (file.status === "active" && updated.status === "active" && !adopting) this.store.acknowledge(updated.id);
      }
      if (charterChanged) this.#writeCharter(current.id, doc.path, charter);
      this.#finish(current.id, file, base, marker);
    } };
  }

  #writeCharter(agentId: string, path: string, charter: string): void {
    if (!charter.trim()) return;
    const existing = this.store.getFile(agentId, "AGENTS.md");
    if (existing && existing.content.trim() === charter.trim()) return;
    this.store.putFile(agentId, "AGENTS.md", charter, existing ? existing.revision : null, "human", `file:${path}`.slice(0, 200));
  }

  /** Pairs every file trigger with the trigger it owns (from the marker), or an equal unowned one when adopting. */
  #triggerRows(agent: Sentinel, marker: SentinelManagedBy | undefined, file: AgentFile): TriggerRow[] {
    const mapped = marker?.triggers ?? {};
    const owned = new Set(Object.values(mapped).map(entry => entry.trigger));
    const free = marker ? [] : this.store.listTriggers(agent.id).filter(trigger => !owned.has(trigger.id));
    return desiredTriggers(file).map(want => {
      let entry = mapped[want.key];
      let existing = entry ? this.store.getTrigger(entry.trigger) ?? undefined : undefined;
      if (!existing && !marker) {
        const index = free.findIndex(trigger => trigger.kind === want.kind && stable(trigger.schedule ?? null) === stable(want.schedule ?? null) && stable(trigger.github ?? null) === stable(want.github ?? null));
        if (index >= 0) { existing = free.splice(index, 1)[0]; entry = { trigger: existing!.id, created: false }; }
      }
      if (!existing) return { key: want.key, want, created: true, same: false };
      const workflow = this.workflows.get(existing.automationId);
      const created = entry?.created ?? false;
      const same = existing.kind === want.kind && existing.enabled === want.enabled && stable(existing.schedule ?? null) === stable(want.schedule ?? null) && stable(existing.github ?? null) === stable(want.github ?? null)
        && (created ? workflow?.template?.id === want.template && workflow?.target === automationTarget(file) && workflow?.runIn === want.runIn : want.explicitTemplate === undefined || workflow?.template?.id === want.explicitTemplate);
      return { key: want.key, want, existing, created, same };
    });
  }

  /** Writes the triggers of a file, then records the marker with the new state digest. */
  #finish(agentId: string, file: AgentFile, base: Omit<SentinelManagedBy, "stateHash" | "triggers">, previous?: SentinelManagedBy): void {
    const agent = this.store.get(agentId)!;
    const rows = this.#triggerRows(agent, previous, file);
    const triggers: Record<string, { trigger: string; created: boolean }> = {};
    for (const row of rows) {
      const { want } = row;
      const body = { kind: want.kind, ...(want.schedule ? { schedule: want.schedule } : {}), ...(want.github ? { github: want.github } : {}) };
      if (!row.existing) {
        const definition = createSecurityWorkflowTemplate(want.template, { target: automationTarget(file) });
        const workflow = this.workflows.save({ ...definition, name: `${file.name}: ${getSecurityWorkflowTemplate(want.template).name}`.slice(0, 160), ownerSentinelId: agentId, runIn: want.runIn });
        triggers[row.key] = { trigger: this.store.createTrigger(agentId, { automationId: workflow.id, ...body, enabled: want.enabled }).id, created: true };
        continue;
      }
      triggers[row.key] = { trigger: row.existing.id, created: row.created };
      if (row.same) continue;
      const workflow = this.workflows.get(row.existing.automationId);
      if (workflow) {
        const wantTemplate = row.created ? want.template : want.explicitTemplate;
        const target = row.created ? automationTarget(file) : workflow.target;
        if (wantTemplate !== undefined && (workflow.template?.id !== wantTemplate || workflow.target !== target || (row.created && workflow.runIn !== want.runIn))) {
          const definition = createSecurityWorkflowTemplate(wantTemplate, { target });
          this.workflows.save({ ...definition, id: workflow.id, revision: workflow.revision, name: workflow.name, ownerSentinelId: agentId, runIn: row.created ? want.runIn : workflow.runIn ?? want.runIn });
        }
      }
      if (row.existing.enabled !== want.enabled || stable(row.existing.schedule ?? null) !== stable(want.schedule ?? null) || stable(row.existing.github ?? null) !== stable(want.github ?? null)) {
        this.store.updateTrigger(row.existing.id, { enabled: want.enabled, ...(want.schedule ? { schedule: want.schedule } : {}), ...(want.github ? { github: want.github } : {}) }, row.existing.version);
      }
    }
    // Triggers that left the file: removed, along with the automation when apply created it.
    for (const [key, entry] of Object.entries(previous?.triggers ?? {})) {
      if (triggers[key]) continue;
      const trigger = this.store.getTrigger(entry.trigger);
      if (trigger) { this.store.deleteTrigger(trigger.id); if (entry.created) this.workflows.delete(trigger.automationId); }
    }
    const withTriggers = this.store.setManagedBy(agentId, { ...base, triggers });
    this.store.setManagedBy(agentId, { ...base, triggers, stateHash: this.#stateHash(withTriggers) });
  }

  #remove(agent: Sentinel): void {
    for (const entry of Object.values(agent.managedBy?.triggers ?? {})) {
      const trigger = this.store.getTrigger(entry.trigger);
      if (trigger && entry.created) { this.store.deleteTrigger(trigger.id); this.workflows.delete(trigger.automationId); }
    }
    this.store.delete(agent.id);
    this.workflows.clearOwnerSentinel(agent.id);
  }

  /** The file for one Agent: managed Agents keep their file id; others get an id from the name (see exportAll for collisions). */
  exportAgent(agentId: string, id?: string): { path: string; content: string; id: string; agentId: string } {
    const agent = this.store.get(agentId);
    if (!agent) throw new AgentApplyError("Agent not found.", 404);
    const fileId = id ?? agent.managedBy?.id ?? slugOf(agent.name);
    const mapped = new Map(Object.entries(agent.managedBy?.triggers ?? {}).map(([key, entry]) => [entry.trigger, key]));
    const used = new Set<string>();
    const triggers = this.store.listTriggers(agent.id).map((trigger, index) => {
      const workflow = this.workflows.get(trigger.automationId);
      let key = mapped.get(trigger.id) ?? `${trigger.kind}-${index + 1}`;
      while (used.has(key)) key = `${key}-x`;
      used.add(key);
      return { on: trigger.kind, id: key, ...(workflow?.template ? { template: workflow.template.id } : {}), enabled: trigger.enabled, ...(trigger.schedule ?? {}), ...(trigger.github ?? {}) };
    });
    const charter = this.store.getFile(agent.id, "AGENTS.md")?.content ?? "";
    return { id: fileId, path: `${fileId}.md`, agentId: agent.id, content: agentFileText({ id: fileId, sentinel: agent, triggers }, charter) };
  }

  /** A file for every Agent that is not archived: ids are unique and stable (the oldest keeps the plain slug). Changes nothing. */
  exportAll(): Array<{ path: string; content: string; id: string; agentId: string }> {
    const agents = this.store.list().filter(agent => agent.status !== "archived").sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    const taken = new Set(agents.flatMap(agent => (agent.managedBy ? [agent.managedBy.id] : [])));
    return agents.map(agent => {
      let id = agent.managedBy?.id ?? slugOf(agent.name);
      if (!agent.managedBy && taken.has(id)) id = `${id.slice(0, 54)}-${shortId(agent.id)}`;
      taken.add(id);
      return this.exportAgent(agent.id, id);
    });
  }
}

interface FileSource { id: string; sentinel: Pick<Sentinel, "name" | "mission" | "role" | "skills" | "scope" | "autonomy" | "toolAccess" | "budget" | "memory" | "model" | "notifications" | "avatar" | "status">; triggers: Array<Record<string, unknown>> }
function agentFileText(source: FileSource, charter: string): string {
  const s = source.sentinel;
  const scope = Object.fromEntries((["repos", "targets", "domains", "outOfScope"] as const).filter(key => s.scope[key].length).map(key => [key, s.scope[key]]));
  const access = sentinelAccessLevel(s.autonomy);
  const front: Record<string, unknown> = {
    apiVersion: AGENT_FILE_API_VERSION, kind: "Agent", id: source.id, name: s.name, ...(s.mission ? { description: s.mission } : {}),
    ...(s.role !== "custom" ? { preset: s.role } : {}), access, ...(access === "read-only" && s.toolAccess === "read-web" ? { web: true } : {}), status: s.status === "archived" ? "paused" : s.status,
    ...(s.skills.length ? { skills: s.skills } : {}), ...(Object.keys(scope).length ? { scope } : {}), budget: { dailyUsd: s.budget.dailyUsd, maxRunsPerDay: s.budget.maxRunsPerDay },
    memory: s.memory.autoLearn ? { enabled: s.memory.enabled, autoLearn: true } : s.memory.enabled,
    ...(s.model ? { model: { provider: s.model.providerId, model: s.model.model, ...(s.model.reasoning ? { reasoning: s.model.reasoning } : {}) } } : {}),
    ...(JSON.stringify(s.notifications) !== JSON.stringify({ channels: ["in-app"], on: ["finding-high", "needs-you", "run-failed"], quiet: false }) ? { notifications: s.notifications } : {}),
    ...(s.avatar ? { avatar: { color: s.avatar.color, ...(s.avatar.icon ? { icon: s.avatar.icon } : {}) } } : {}),
    ...(source.triggers.length ? { triggers: source.triggers } : {}),
  };
  const text = serializeAgentFile(front, charter);
  // The exported text must be a valid file; fail loudly rather than hand out something that cannot be applied.
  const check = parseAgentFile(text);
  if (!check.ok) throw new AgentApplyError(`This Agent cannot be written as a file: ${check.errors[0]?.message ?? "invalid"}`, 409);
  return text;
}

/** A built-in preset as a file (paused; triggers off; a placeholder repository where the preset needs one). */
export function presetAgentFile(preset: SentinelPreset): { path: string; content: string } {
  const sentinel = { ...preset.sentinel, scope: { repos: [], targets: [], domains: [], outOfScope: [], production: false }, budget: { dailyUsd: 10, maxRunsPerDay: 20 }, memory: { enabled: true, autoLearn: false }, model: null, notifications: { channels: ["in-app" as const], on: ["finding-high" as const, "needs-you" as const, "run-failed" as const], quiet: false }, status: "paused" as const };
  const charter = defaultSentinelFiles({ name: preset.name, mission: preset.sentinel.mission, scope: sentinel.scope, autonomy: preset.autonomy }, preset.sentinel.instructions)["AGENTS.md"];
  const weekly = { frequency: "weekly", weekday: 1, time: "09:00", timezone: "UTC" };
  const triggers = preset.suggestedAutomations.map((item, index) => {
    const base = { on: item.trigger.kind, id: `${item.trigger.kind}-${index + 1}`, ...(item.templateId ? { template: item.templateId } : {}), enabled: false };
    if (item.trigger.kind === "schedule") return { ...base, ...(item.trigger.cadence === "weekly" ? weekly : item.trigger.cadence === "daily" ? { frequency: "daily", time: "09:00", timezone: "UTC" } : { frequency: "hourly", time: "00:00", timezone: "UTC" }) };
    if (item.trigger.kind === "github-pr") return { ...base, repo: "your-org/your-repo" };
    return base;
  });
  return { path: `${preset.id}.md`, content: agentFileText({ id: preset.id, sentinel, triggers }, charter) };
}
