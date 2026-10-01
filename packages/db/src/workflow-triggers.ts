import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveOsecDbPath } from "./database.js";
import { createShimmedDatabase, type ShimmedDatabase } from "./wasm-shim.js";

export type WorkflowTriggerCadence = "hourly" | "daily" | "weekly";
export interface WorkflowTrigger {
  id: string; version?:number; workflowId: string; workflowRevision: number; sessionId: string;
  kind: "schedule"; cadence: WorkflowTriggerCadence; startAt: string; timezone: string;
  reviewedConnectionIdentity?: string; reviewedModel?: string; reviewedProviderId?: string;
  enabled: boolean; nextFireAt: string; lastStatus?: string; lastError?: string;
  lastExecutionId?: string; activeClaim?: string; ownerPid?: number;
  createdAt: string; updatedAt: string;
}
export const TRIGGER_INTERVAL_MS: Record<WorkflowTriggerCadence, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
/** Fixed elapsed intervals anchored to an ISO timestamp. Timezone is display metadata, not DST cron semantics. */
export function nextWorkflowTriggerFire(startAt: string, cadence: WorkflowTriggerCadence, now: number): string {
  const anchor = Date.parse(startAt); const interval = TRIGGER_INTERVAL_MS[cadence];
  if (!Number.isFinite(anchor) || !interval || !Number.isFinite(now)) throw new Error("Invalid schedule.");
  return new Date(anchor > now ? anchor : anchor + (Math.floor((now - anchor) / interval) + 1) * interval).toISOString();
}
export class WorkflowTriggerStore {
  readonly #db: ShimmedDatabase;
  constructor(dbPath?: string) {
    const path = resolveOsecDbPath(dbPath); if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = createShimmedDatabase(path); this.#db.pragma("busy_timeout = 5000");
    this.#db.exec("CREATE TABLE IF NOT EXISTS workflow_triggers (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, enabled INTEGER NOT NULL, next_fire_at TEXT NOT NULL, active_claim TEXT, trigger_json TEXT NOT NULL)");
    this.#db.exec("CREATE INDEX IF NOT EXISTS workflow_triggers_due ON workflow_triggers(enabled, next_fire_at)");
  }
  get(id: string): WorkflowTrigger | null { const row = this.#db.prepare("SELECT trigger_json FROM workflow_triggers WHERE id = ?").all(id)[0]; return row ? JSON.parse(String((row as {trigger_json:string}).trigger_json)) : null; }
  list(workflowId?: string): WorkflowTrigger[] { return this.#db.prepare("SELECT trigger_json FROM workflow_triggers WHERE (? IS NULL OR workflow_id = ?) ORDER BY next_fire_at, id LIMIT 200").all(workflowId ?? null, workflowId ?? null).map(row => JSON.parse(String((row as {trigger_json:string}).trigger_json))); }
  create(input: Pick<WorkflowTrigger, "workflowId" | "workflowRevision" | "sessionId" | "cadence" | "startAt" | "timezone" | "enabled"> & Pick<WorkflowTrigger,"reviewedConnectionIdentity"|"reviewedModel"|"reviewedProviderId">, now = Date.now()): WorkflowTrigger {
    const stamp = new Date(now).toISOString(); const trigger: WorkflowTrigger = { ...input, kind: "schedule", id: randomUUID(), version:1, nextFireAt: nextWorkflowTriggerFire(input.startAt, input.cadence, now), createdAt: stamp, updatedAt: stamp };
    this.#db.prepare("INSERT INTO workflow_triggers(id,workflow_id,enabled,next_fire_at,active_claim,trigger_json) VALUES(?,?,?,?,NULL,?)").run(trigger.id, trigger.workflowId, trigger.enabled ? 1 : 0, trigger.nextFireAt, JSON.stringify(trigger)); return trigger;
  }
  update(id: string, update: Partial<Pick<WorkflowTrigger,"enabled"|"nextFireAt"|"lastStatus"|"lastError"|"lastExecutionId"|"reviewedModel"|"reviewedProviderId"|"reviewedConnectionIdentity">>, expectedVersion?:number): WorkflowTrigger | null {
    return this.#db.transaction(() => { const current = this.get(id); if (!current) return null; if (expectedVersion !== undefined && (current.version ?? 1) !== expectedVersion) throw new Error("Schedule changed. Review it again before enabling."); const next = { ...current, ...update, version:(current.version ?? 1)+1, updatedAt: new Date().toISOString() }; if (!next.enabled && update.lastStatus === "running") next.lastStatus = "paused"; this.#write(next); return next; })();
  }
  delete(id: string): boolean { return this.#db.prepare("DELETE FROM workflow_triggers WHERE id = ? AND active_claim IS NULL").run(id).changes > 0; }
  /** CAS claims the occurrence across engines; advancing from now skips missed intervals. */
  claim(id: string, now = Date.now()): WorkflowTrigger | null {
    const current = this.get(id); if (!current?.enabled || current.activeClaim || Date.parse(current.nextFireAt) > now) return null;
    const claim = randomUUID(); const next: WorkflowTrigger = { ...current, version:(current.version ?? 1)+1, activeClaim: claim, ownerPid: process.pid, nextFireAt: nextWorkflowTriggerFire(current.startAt, current.cadence, now), lastStatus: "starting", lastExecutionId: undefined, lastError: undefined, updatedAt: new Date(now).toISOString() };
    this.#db.prepare("UPDATE workflow_triggers SET active_claim=?, next_fire_at=?, trigger_json=? WHERE id=? AND enabled=1 AND active_claim IS NULL AND next_fire_at=? AND trigger_json=?").run(claim, next.nextFireAt, JSON.stringify(next), id, current.nextFireAt, JSON.stringify(current));
    return this.get(id)?.activeClaim === claim ? next : null;
  }
  release(id: string, claim: string, update: Partial<Pick<WorkflowTrigger,"enabled"|"lastStatus"|"lastError"|"lastExecutionId">>): WorkflowTrigger | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(id); if (!current || current.activeClaim !== claim) { this.#db.exec("COMMIT"); return null; }
      const next: WorkflowTrigger = { ...current, ...update, version:(current.version ?? 1)+1, enabled: current.enabled && update.enabled !== false, activeClaim: undefined, ownerPid: undefined, updatedAt: new Date().toISOString() };
      if (!current.enabled && update.enabled !== false) next.lastStatus = "paused";
      this.#db.prepare("UPDATE workflow_triggers SET active_claim=NULL,enabled=?,trigger_json=? WHERE id=? AND active_claim=?").run(next.enabled ? 1 : 0, JSON.stringify(next), id, claim);
      this.#db.exec("COMMIT"); return next;
    } catch(error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #write(trigger: WorkflowTrigger): void { this.#db.prepare("UPDATE workflow_triggers SET enabled=?,next_fire_at=?,trigger_json=? WHERE id=?").run(trigger.enabled ? 1 : 0, trigger.nextFireAt, JSON.stringify(trigger), trigger.id); }
  close(): void { this.#db.close(); }
}
