import { z } from "zod";
import { SecurityWorkflowStore, WorkflowTriggerStore, nextWorkflowTriggerFire, type WorkflowTrigger } from "@0/db";

export interface WorkflowTriggerAdapter {
  /** Read-only validation of current runtime and previously reviewed target permissions. Never prompts or grants access. */
  validate(trigger: WorkflowTrigger): Promise<{model:string;providerId:string;connectionIdentity?:string} | void>;
  /** Launch using the reviewed revision and existing permissions, without interactive authorization. */
  launch(trigger: WorkflowTrigger): Promise<{ executionId: string }>;
}
const createSchema = z.object({ workflowId: z.string().min(1).max(160), workflowRevision: z.number().int().positive(), sessionId: z.string().min(1).max(160), cadence: z.enum(["hourly","daily","weekly"]), startAt: z.string().datetime({offset:true}), timezone: z.string().min(1).max(100), enabled: z.boolean(), approval: z.literal("enable-reviewed-trigger").optional() }).strict();
const toggleSchema = z.object({enabled:z.boolean().optional(), cadence:z.enum(["hourly","daily","weekly"]).optional(), startAt:z.string().datetime({offset:true}).optional(), timezone:z.string().min(1).max(100).optional(), workflowRevision:z.number().int().positive().optional(), expectedVersion:z.number().int().positive().optional(), approval:z.literal("enable-reviewed-trigger").optional()}).strict().refine(value => ["enabled", "cadence", "startAt", "timezone", "workflowRevision"].some(key => key in value), "Provide a schedule change.");
const PREFIX = "/api/console/workflow-triggers";
const terminal = new Set(["completed","failed","cancelled","interrupted"]);
export class WorkflowTriggerService {
  readonly #store: WorkflowTriggerStore;
  readonly #workflows: SecurityWorkflowStore;
  readonly #adapter: WorkflowTriggerAdapter;
  readonly #timer: ReturnType<typeof setInterval>;
  #polling = false;
  #closed = false;
  #pending: Promise<void> | undefined;
  constructor(options: {dbPath?:string; adapter:WorkflowTriggerAdapter; pollIntervalMs?:number}) {
    this.#store = new WorkflowTriggerStore(options.dbPath); this.#workflows = new SecurityWorkflowStore(options.dbPath); this.#adapter = options.adapter;
    this.#timer = setInterval(() => { if (this.#polling) return; this.#pending = this.tick().catch(() => { /* A transient database error is retried on the next tick. */ }); }, options.pollIntervalMs ?? 15_000); this.#timer.unref();
  }
  async handle(method: string, url: URL, input: unknown): Promise<{status:number;data:unknown}|null> {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
    try {
      const id = url.pathname.slice(PREFIX.length + 1);
      if (url.pathname === PREFIX && method === "GET") return {status:200,data:{triggers:this.#store.list(url.searchParams.get("workflowId") ?? undefined).map(publicTrigger)}};
      if (url.pathname === PREFIX && method === "POST") {
        const parsed = createSchema.parse(input);
        try { new Intl.DateTimeFormat("en",{timeZone:parsed.timezone}); } catch { return error(400,"Choose a valid timezone."); }
        const definition = this.#workflows.get(parsed.workflowId); if (!definition) return error(404,"Workflow not found.");
        if (definition.revision !== parsed.workflowRevision) return error(409,"Workflow changed. Review the current revision.");
        if (!definition.target.trim()) return error(400,"Set a workflow target before scheduling.");
        if (this.#store.list().length >= 200) return error(409,"Schedule limit reached.");
        const {approval:_approval,...fields} = parsed;
        let identity: {model:string;providerId:string;connectionIdentity?:string} | void = undefined;
        if (parsed.enabled) {
          if (!parsed.approval) return error(400,"Review this schedule before enabling it.");
          identity = await this.#adapter.validate({...fields, id:"review",kind:"schedule",nextFireAt:parsed.startAt,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
        }
        return {status:201,data:{trigger:publicTrigger(this.#store.create({...fields, reviewedConnectionIdentity:identity?.connectionIdentity, reviewedModel:identity?.model, reviewedProviderId:identity?.providerId}))}};
      }
      const trigger = this.#store.get(id); if (!trigger) return error(404,"Schedule not found.");
      if (method === "PATCH") {
        const patch = toggleSchema.parse(input);
        if (patch.expectedVersion !== undefined && patch.expectedVersion !== (trigger.version ?? 1)) return error(409,"Schedule changed. Review it again before enabling.");
        if (trigger.activeClaim && ["cadence", "startAt", "timezone", "workflowRevision"].some(key => key in patch)) return error(409,"Pause the schedule and wait for its active execution before editing.");
        const changedTiming = patch.cadence !== undefined || patch.startAt !== undefined || patch.timezone !== undefined || patch.workflowRevision !== undefined;
        // Editing a schedule never silently preserves automatic execution.
        const enabled = patch.enabled ?? (changedTiming ? false : trigger.enabled);
        const next = { ...trigger, ...patch, enabled };
        try { new Intl.DateTimeFormat("en", { timeZone: next.timezone }); } catch { return error(400,"Choose a valid timezone."); }
        let identity: {model:string;providerId:string;connectionIdentity?:string} | void = undefined;
        if (enabled) {
          if (!patch.approval) return error(400,"Review this schedule before enabling it.");
          const definition = this.#workflows.get(trigger.workflowId);
          if (definition?.revision !== next.workflowRevision) return error(409,"Workflow changed. Review its current revision before scheduling.");
          identity = await this.#adapter.validate(next);
          if (!changedTiming) this.#verifyIdentity(trigger, identity);
        }
        return {status:200,data:{trigger:publicTrigger(this.#store.update(id,{
          cadence:next.cadence,startAt:next.startAt,timezone:next.timezone,workflowRevision:next.workflowRevision,
          ...(enabled ? {reviewedModel:identity?.model, reviewedProviderId:identity?.providerId, reviewedConnectionIdentity:identity?.connectionIdentity} : {}),
          enabled,lastStatus:enabled ? "scheduled" : "paused",lastError:undefined,nextFireAt:nextWorkflowTriggerFire(next.startAt,next.cadence,Date.now()),
        }, enabled ? trigger.version ?? 1 : patch.expectedVersion)!)}};
      }
      if (method === "DELETE") { if (!this.#store.delete(id)) return error(409,"Pause the schedule and wait for its active execution before deleting."); return {status:200,data:{deleted:true}}; }
      return error(405,"Unsupported schedule action.");
    } catch (cause) { return error(cause instanceof z.ZodError ? 400 : 409, cause instanceof Error ? cause.message.slice(0,1000) : "Schedule could not be updated."); }
  }
  /** Chat transport shares the same validation and scheduler as the HTTP editor. */
  async invokeLifecycle(sessionId: string, name: string, args: Record<string, unknown>, context?: { workflowId?: string; activationApproved?: boolean }): Promise<unknown> {
    const identifier = z.string().min(1).max(160);
    if (name === "list_schedules") {
      const request = z.object({ workflowId:identifier.optional() }).strict().parse(args);
      if (context?.workflowId && request.workflowId && context.workflowId !== request.workflowId) throw new Error("This editor is bound to another workflow.");
      return { schedules:this.#store.list(context?.workflowId ?? request.workflowId).filter(trigger => context?.workflowId || trigger.sessionId === sessionId).map(publicTrigger) };
    }
    let method: string; let path = PREFIX; let input: unknown;
    if (name === "create_schedule") {
      const request = createSchema.omit({sessionId:true,approval:true}).extend({enabled:z.boolean().default(false)}).parse(args);
      if (context?.workflowId && context.workflowId !== request.workflowId) throw new Error("This editor is bound to another workflow.");
      if (request.enabled && !context?.activationApproved) throw new Error("Schedule activation requires operator approval.");
      method="POST"; input={...request,sessionId,...(request.enabled ? {approval:"enable-reviewed-trigger"} : {})};
    } else if (name === "update_schedule" || name === "delete_schedule") {
      const {id, ...fields} = z.object({id:identifier}).passthrough().parse(args);
      const trigger = this.#store.get(id);
      if (!trigger || (context?.workflowId ? trigger.workflowId !== context.workflowId : trigger.sessionId !== sessionId)) throw new Error("Schedule not found for this editor.");
      path += `/${encodeURIComponent(id)}`;
      if (name === "delete_schedule") { z.object({}).strict().parse(fields); method="DELETE"; input=undefined; }
      else {
        const patch = toggleSchema.parse(fields);
        if (patch.enabled && !context?.activationApproved) throw new Error("Schedule activation requires operator approval.");
        method="PATCH"; input={...patch,...(patch.enabled ? {approval:"enable-reviewed-trigger"} : {})};
      }
    } else throw new Error("Unknown schedule action.");
    const result = await this.handle(method,new URL(path,"http://localhost"),input);
    if (!result || result.status >= 400) throw new Error((result?.data as {error?:string})?.error ?? "Schedule could not be updated.");
    return result.data;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.#closed || this.#polling) return; this.#polling = true;
    try {
      for (const trigger of this.#store.list()) {
        if (this.#closed) break;
        if (trigger.activeClaim) {
          if (trigger.lastExecutionId) {
            const execution = this.#workflows.getExecution(trigger.lastExecutionId);
            if (execution && terminal.has(execution.status)) this.#store.release(trigger.id,trigger.activeClaim,{lastStatus:execution.status,lastError:execution.error});
          }
          if (trigger.ownerPid && !isProcessAlive(trigger.ownerPid)) this.#store.release(trigger.id,trigger.activeClaim,{enabled:false,lastStatus:"interrupted",lastError:"The engine stopped. Review and enable the schedule again."});
          continue;
        }
        if (!trigger.enabled) continue;
        const definition = this.#workflows.get(trigger.workflowId);
        if (definition?.revision !== trigger.workflowRevision) { this.#store.update(trigger.id,{enabled:false,lastStatus:"needs_review",lastError:"The workflow changed. Review its current revision before scheduling again."}); continue; }
        if (Date.parse(trigger.nextFireAt) > now) continue;
        const claimed = this.#store.claim(trigger.id,now); if (!claimed?.activeClaim) continue;
        // A stopped engine never replays its missed schedule occurrences.
        if (now - Date.parse(trigger.nextFireAt) > 60_000) { this.#store.release(claimed.id,claimed.activeClaim,{lastStatus:"skipped_missed"}); continue; }
        try {
          this.#verifyIdentity(claimed, await this.#adapter.validate(claimed));
          const latest = this.#store.get(claimed.id);
          if (this.#closed || !latest?.enabled || latest.activeClaim !== claimed.activeClaim) { this.#store.release(claimed.id,claimed.activeClaim,{lastStatus:"paused"}); continue; }
          const result = await this.#adapter.launch(claimed);
          this.#store.update(claimed.id,{lastExecutionId:result.executionId,lastStatus:"running",lastError:undefined});
        } catch (cause) {
          this.#store.release(claimed.id,claimed.activeClaim,{enabled:false,lastStatus:"blocked",lastError:cause instanceof Error ? cause.message.slice(0,1000) : "Review the connection and permissions before enabling this schedule."});
        }
      }
    } finally { this.#polling = false; }
  }
  #verifyIdentity(trigger:WorkflowTrigger, identity:{model:string;providerId:string;connectionIdentity?:string}|void):void { if ((trigger.reviewedConnectionIdentity && trigger.reviewedConnectionIdentity !== identity?.connectionIdentity) || (trigger.reviewedModel && trigger.reviewedModel !== identity?.model) || (trigger.reviewedProviderId && trigger.reviewedProviderId !== identity?.providerId)) throw new Error("The model connection changed. Review a new schedule before running."); }
  async dispose(): Promise<void> { this.#closed = true; clearInterval(this.#timer); await this.#pending; this.#store.close(); this.#workflows.close(); }
}
function error(status:number,message:string): {status:number;data:unknown} { return {status,data:{error:message}}; }
function isProcessAlive(pid:number):boolean { try {process.kill(pid,0);return true;} catch(cause) {return !(cause && typeof cause === "object" && "code" in cause && cause.code === "ESRCH");} }

function publicTrigger(trigger:WorkflowTrigger):Omit<WorkflowTrigger,"reviewedConnectionIdentity"> { const {reviewedConnectionIdentity:_identity,...visible}=trigger; return visible; }
