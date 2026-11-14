import { z } from "zod";
import { SecurityWorkflowStore, SentinelStore, SentinelStoreError } from "@0/engine/storage";
import { SENTINEL_FILE_FOLDERS, SENTINEL_PRESETS, SENTINEL_STATUSES, describeSentinelSchedule, getSentinelPreset, sentinelNeedsReview, type Sentinel, type SentinelActivation, type SentinelAttention, type SentinelTrigger } from "@0/engine/shared";
import { SentinelRunError, SentinelRunner, type SentinelActor, type SentinelGhClient, type SentinelMissionRuntime } from "./sentinel-runner.js";

const PREFIX = "/api/console/";
const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const DAY_MS = 86_400_000;

export type { SentinelActor, SentinelMissionRuntime, SentinelGhClient } from "./sentinel-runner.js";
class SentinelRequestError extends Error {
  constructor(message: string, readonly status: number = 409) { super(message); }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SentinelRequestError(result.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "), 400);
  return result.data;
}
const bodyOf = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4_000);

export class WebSentinelService {
  readonly #store: SentinelStore;
  readonly #workflows: SecurityWorkflowStore;
  readonly #missions: SentinelMissionRuntime;
  readonly #now: () => number;
  readonly #runner: SentinelRunner;
  /**
   * `scheduler` starts the background tick (schedules, GitHub PR polling, run tracking). Off by default so tests and
   * tools that only need the HTTP surface do not run autonomous work; the dashboard turns it on.
   */
  constructor(options: { dbPath?: string; missions: SentinelMissionRuntime; now?: () => number; scheduler?: boolean | { pollIntervalMs?: number }; gh?: SentinelGhClient }) {
    this.#store = new SentinelStore(options.dbPath);
    this.#workflows = new SecurityWorkflowStore(options.dbPath);
    this.#missions = options.missions;
    this.#now = options.now ?? Date.now;
    this.#runner = new SentinelRunner({ store: this.#store, workflows: this.#workflows, missions: options.missions, now: this.#now, ...(options.gh ? { gh: options.gh } : {}) });
    if (options.scheduler) this.#runner.start(typeof options.scheduler === "object" ? options.scheduler.pollIntervalMs : undefined);
  }
  /** Drives one scheduler pass; the background timer calls this. Exposed for tests and for an explicit "check now". */
  tick(nowMs?: number): Promise<void> { return this.#runner.tick(nowMs); }
  async dispose(): Promise<void> { await this.#runner.dispose(); this.#store.close(); this.#workflows.close(); }

  /** Auth (control token / team session) is enforced before this is reached; this layer adds team roles. */
  async handle(pathname: string, method: string, input: unknown, query: URLSearchParams, actor?: SentinelActor): Promise<{ status: number; data: unknown } | null> {
    if (pathname !== PREFIX + "sentinels" && !pathname.startsWith(PREFIX + "sentinels/") && pathname !== PREFIX + "sentinel-presets") return null;
    try {
      return await this.#route(pathname.slice(PREFIX.length), method, input, query, actor);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof SentinelRequestError ? error.status
        : error instanceof SentinelStoreError ? error.statusCode
        : error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      return { status, data: { error: status === 500 ? "Sentinel request failed." : message(error) } };
    }
  }

  #requireWriter(actor?: SentinelActor): void {
    if (actor?.role === "viewer") throw new SentinelRequestError("Viewers cannot change Sentinels.", 403);
  }
  #requireSentinel(id: string): Sentinel {
    const sentinel = this.#store.get(id);
    if (!sentinel) throw new SentinelRequestError("Sentinel not found.", 404);
    return sentinel;
  }
  #attention(sentinel: Sentinel): SentinelAttention {
    const missions = new Set<string>();
    if (sentinel.homeMissionId) missions.add(sentinel.homeMissionId);
    for (const activation of this.#store.listActivations(sentinel.id, 5)) if (activation.status === "running" && activation.missionId) missions.add(activation.missionId);
    let pending = 0;
    for (const id of missions) { try { pending += this.#missions.pendingDecisions(id); } catch { /* A closed mission has nothing pending. */ } }
    const needsReview = sentinelNeedsReview(sentinel);
    const reason = sentinel.pauseReason?.message ?? (needsReview ? "Scope, model, tools or skills changed since the last review." : undefined);
    return { needsYou: pending > 0 || Boolean(sentinel.pauseReason) || needsReview, needsReview, pendingDecisions: pending, ...(reason ? { reason } : {}) };
  }
  #view(sentinel: Sentinel) { return { ...sentinel, attention: this.#attention(sentinel) }; }
  #automations(id: string) { return this.#workflows.list().filter(workflow => workflow.ownerSentinelId === id); }

  async #route(path: string, method: string, input: unknown, query: URLSearchParams, actor?: SentinelActor): Promise<{ status: number; data: unknown }> {
    if (path === "sentinel-presets") {
      if (method !== "GET") throw new SentinelRequestError("Use GET to list Sentinel presets.", 405);
      return { status: 200, data: { presets: SENTINEL_PRESETS } };
    }
    if (path === "sentinels") {
      if (method === "GET") {
        const status = query.get("status");
        if (status !== null && !(SENTINEL_STATUSES as readonly string[]).includes(status)) throw new SentinelRequestError("Unknown status filter.", 400);
        return { status: 200, data: { sentinels: this.#store.list(status as Sentinel["status"] | undefined ?? undefined).map(sentinel => this.#view(sentinel)) } };
      }
      if (method === "POST") {
        this.#requireWriter(actor);
        const { preset: presetId, ...rest } = bodyOf(input);
        let body: Record<string, unknown> = rest;
        let suggestedAutomations;
        if (presetId !== undefined) {
          const preset = typeof presetId === "string" ? getSentinelPreset(presetId) : undefined;
          if (!preset) throw new SentinelRequestError("Unknown Sentinel preset.", 400);
          body = { ...preset.sentinel, ...rest };
          suggestedAutomations = preset.suggestedAutomations;
        }
        const sentinel = this.#store.create(body, actor?.userId ?? "local");
        return { status: 201, data: { sentinel: this.#view(sentinel), ...(suggestedAutomations ? { suggestedAutomations } : {}) } };
      }
      throw new SentinelRequestError("Use GET or POST for Sentinels.", 405);
    }
    const match = path.match(/^sentinels\/([^/]+)(?:\/(.*))?$/);
    if (!match) throw new SentinelRequestError("Unknown Sentinel route.", 404);
    const id = parse(idSchema, decodeURIComponent(match[1]!));
    const rest = match[2];
    if (rest === undefined) {
      if (method === "GET") return { status: 200, data: { sentinel: this.#view(this.#requireSentinel(id)) } };
      if (method === "PATCH") { this.#requireWriter(actor); return { status: 200, data: { sentinel: this.#view(this.#store.update(id, input)) } }; }
      if (method === "DELETE") {
        this.#requireWriter(actor);
        const sentinel = this.#requireSentinel(id);
        if (actor?.role === "editor" && sentinel.owner !== actor.userId) throw new SentinelRequestError("Only the owner or a workspace owner can delete this Sentinel.", 403);
        if (!query.has("version")) throw new SentinelRequestError("Deleting requires the reviewed Sentinel version.", 409);
        this.#store.delete(id, parse(z.number().int().positive(), Number(query.get("version"))));
        // Hard delete detaches the automations it owned so no dangling ownerSentinelId survives; triggers went with the record.
        const detached = this.#workflows.clearOwnerSentinel(id);
        return { status: 200, data: { ok: true, detachedAutomations: detached } };
      }
      throw new SentinelRequestError("Use GET, PATCH or DELETE for a Sentinel.", 405);
    }
    if ((rest === "pause" || rest === "resume") && method === "POST") {
      this.#requireWriter(actor);
      const body = parse(z.object({ version: z.number().int().positive().optional(), acknowledge: z.boolean().optional() }).strict(), bodyOf(input));
      if (rest === "pause" && body.acknowledge) throw new SentinelRequestError("Acknowledge applies to resume.", 400);
      return { status: 200, data: { sentinel: this.#view(this.#store.setStatus(id, rest === "pause" ? "paused" : "active", body.version, undefined, body.acknowledge === true)) } };
    }
    if (rest === "acknowledge" && method === "POST") {
      this.#requireWriter(actor);
      const { version } = parse(z.object({ version: z.number().int().positive().optional() }).strict(), bodyOf(input));
      return { status: 200, data: { sentinel: this.#view(this.#store.acknowledge(id, version)) } };
    }
    if (rest === "budget" && method === "GET") {
      const sentinel = this.#requireSentinel(id);
      const now = this.#now();
      return { status: 200, data: { budget: sentinel.budget, usage: this.#store.ledger(id, new Date(now - DAY_MS).toISOString()), windowMs: DAY_MS, pauseReason: sentinel.pauseReason ?? null } };
    }
    if (rest === "triggers" || rest.startsWith("triggers/")) return await this.#triggers(id, rest === "triggers" ? "" : rest.slice("triggers/".length), method, input, actor);
    if (rest === "run" && method === "POST") { this.#requireWriter(actor); return await this.#run(id, input, actor); }
    if (rest === "activations" && method === "GET") {
      this.#requireSentinel(id);
      const limit = query.has("limit") ? parse(z.number().int().min(1).max(200), Number(query.get("limit"))) : 50;
      return { status: 200, data: { activations: this.#store.listActivations(id, limit) } };
    }
    if (rest === "automations" && method === "GET") { this.#requireSentinel(id); return { status: 200, data: { automations: this.#automations(id) } }; }
    if (rest === "files" || rest.startsWith("files/")) return this.#files(id, rest === "files" ? "" : rest.slice("files/".length), method, input, query, actor);
    throw new SentinelRequestError("Unsupported Sentinel action.", 405);
  }

  #triggerView(trigger: SentinelTrigger) {
    const { activeClaim: _claim, ...visible } = trigger;
    return { ...visible, ...(trigger.schedule ? { summary: describeSentinelSchedule(trigger.schedule) } : {}) };
  }

  /** Triggers start runs of an owned automation. Enabling one needs the same explicit review approval schedules use. */
  async #triggers(id: string, triggerId: string, method: string, input: unknown, actor?: SentinelActor): Promise<{ status: number; data: unknown }> {
    const sentinel = this.#requireSentinel(id);
    if (!triggerId) {
      if (method === "GET") return { status: 200, data: { triggers: this.#store.listTriggers(id).map(trigger => this.#triggerView(trigger)) } };
      if (method !== "POST") throw new SentinelRequestError("Use GET or POST for triggers.", 405);
      this.#requireWriter(actor);
      const { approval, ...fields } = bodyOf(input);
      if (fields.enabled === true && approval !== "enable-reviewed-trigger") throw new SentinelRequestError("Review this trigger before enabling it.", 400);
      if (sentinel.status === "archived") throw new SentinelRequestError("Archived Sentinels cannot have triggers.", 409);
      const automationId = typeof fields.automationId === "string" ? fields.automationId : "";
      const automation = automationId ? this.#workflows.get(automationId) : null;
      if (!automation) throw new SentinelRequestError("Automation not found.", 404);
      if (automation.ownerSentinelId !== id) throw new SentinelRequestError("This automation is not owned by this Sentinel.", 409);
      return { status: 201, data: { trigger: this.#triggerView(this.#store.createTrigger(id, fields, this.#now())) } };
    }
    const trigger = this.#store.getTrigger(triggerId);
    if (!trigger || trigger.sentinelId !== id) throw new SentinelRequestError("Trigger not found.", 404);
    this.#requireWriter(actor);
    if (method === "PATCH") {
      const { approval, expectedVersion, ...patch } = bodyOf(input);
      const body = parse(z.object({ enabled: z.boolean().optional(), schedule: z.unknown().optional(), github: z.unknown().optional() }).strict(), patch);
      if (body.enabled === true && approval !== "enable-reviewed-trigger") throw new SentinelRequestError("Review this trigger before enabling it.", 400);
      const version = expectedVersion === undefined ? undefined : parse(z.number().int().positive(), expectedVersion);
      return { status: 200, data: { trigger: this.#triggerView(this.#store.updateTrigger(triggerId, body, version, this.#now())) } };
    }
    if (method === "DELETE") {
      if (!this.#store.deleteTrigger(triggerId)) throw new SentinelRequestError("Trigger is launching a run; try again in a moment.", 409);
      return { status: 200, data: { ok: true } };
    }
    throw new SentinelRequestError("Use PATCH or DELETE for a trigger.", 405);
  }

  #files(id: string, rawPath: string, method: string, input: unknown, query: URLSearchParams, actor?: SentinelActor): { status: number; data: unknown } {
    this.#requireSentinel(id);
    if (!rawPath) {
      if (method !== "GET") throw new SentinelRequestError("Use GET to list files.", 405);
      return { status: 200, data: { files: this.#store.listFiles(id), folders: SENTINEL_FILE_FOLDERS } };
    }
    const path = rawPath.split("/").map(part => { try { return decodeURIComponent(part); } catch { throw new SentinelRequestError("Invalid file path.", 400); } }).join("/");
    if (method === "GET") {
      const file = this.#store.getFile(id, path);
      if (!file) throw new SentinelRequestError("File not found.", 404);
      return { status: 200, data: { file, ...(query.get("revisions") === "1" ? { revisions: this.#store.listFileRevisions(id, path) } : {}) } };
    }
    this.#requireWriter(actor);
    if (method === "PUT") {
      const body = parse(z.object({ content: z.string(), revision: z.number().int().positive().nullable() }).strict(), input);
      const author = actor?.userId ?? "local";
      return { status: body.revision === null ? 201 : 200, data: { file: this.#store.putFile(id, path, body.content, body.revision, "human", author) } };
    }
    if (method === "DELETE") {
      const revision = query.has("revision") ? parse(z.number().int().positive(), Number(query.get("revision"))) : undefined;
      if (revision === undefined) throw new SentinelRequestError("Deleting requires the reviewed file revision.", 409);
      if (!this.#store.deleteFile(id, path, revision)) throw new SentinelRequestError("File not found.", 404);
      return { status: 200, data: { ok: true } };
    }
    throw new SentinelRequestError("Use GET, PUT or DELETE for a file.", 405);
  }

  /** Manual activation: a new mission seeded from the charter, through the same session path chats use. */
  async #run(id: string, input: unknown, actor?: SentinelActor): Promise<{ status: number; data: unknown }> {
    const body = parse(z.object({ approval: z.literal("launch-authorized-run"), version: z.number().int().positive(), task: z.string().trim().max(4_000).optional() }).strict(), bodyOf(input));
    const sentinel = this.#requireSentinel(id);
    if (sentinel.version !== body.version) throw new SentinelRequestError("Sentinel changed. Review it again before running.", 409);
    let activation: SentinelActivation;
    try { activation = await this.#runner.launch(id, { trigger: { kind: "manual" }, ...(body.task ? { task: body.task } : {}), ...(actor ? { actor } : {}), autonomous: false }); }
    catch (error) { if (error instanceof SentinelRunError) throw new SentinelRequestError(error.message, error.statusCode); throw error; }
    return { status: 202, data: { activation, sentinel: this.#view(this.#requireSentinel(id)) } };
  }
}
