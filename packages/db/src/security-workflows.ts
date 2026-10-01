import { randomUUID } from "node:crypto";
import { ensureDatabaseDirectory } from "./db-directory.js";
import { parseSecurityWorkflowInput, type SecurityWorkflow, type SecurityWorkflowExecution, type SecurityWorkflowExecutionStatus, type SecurityWorkflowNodeResult } from "@0/shared";
import { resolveOsecDbPath } from "./database.js";
import { createShimmedDatabase, type ShimmedDatabase } from "./wasm-shim.js";

export class SecurityWorkflowStoreError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); this.name = "SecurityWorkflowStoreError"; }
}
export interface SecurityWorkflowExecutionUpdate { status?: SecurityWorkflowExecutionStatus; jobId?: string; nodeResults?: Record<string, SecurityWorkflowNodeResult>; error?: string }
const activeStatuses: Partial<Record<SecurityWorkflowExecutionStatus, true>> = { queued: true, running: true };
const statuses: Record<SecurityWorkflowExecutionStatus, true> = { queued: true, running: true, completed: true, failed: true, cancelled: true, interrupted: true };

/** Dedicated durable definitions/history in the control database. Never resumes work implicitly. */
export class SecurityWorkflowStore {
  readonly #db: ShimmedDatabase;
  readonly #runnerInstanceId = randomUUID();
  constructor(dbPath?: string) {
    const path = resolveOsecDbPath(dbPath);
    ensureDatabaseDirectory(path);
    this.#db = createShimmedDatabase(path);
    this.#db.pragma("busy_timeout = 5000");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS workflow_definitions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_executions (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, execution_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_executions_workflow ON workflow_executions(workflow_id, created_at);
      CREATE INDEX IF NOT EXISTS workflow_executions_session ON workflow_executions(session_id, created_at);`);
    this.#db.exec("CREATE TABLE IF NOT EXISTS workflow_execution_results (execution_id TEXT PRIMARY KEY, result_json TEXT NOT NULL);");
  }
  list(): SecurityWorkflow[] { return this.#db.prepare("SELECT definition_json FROM workflow_definitions ORDER BY updated_at DESC, id").all().map(row => JSON.parse(String((row as { definition_json: string }).definition_json)) as SecurityWorkflow); }
  get(id: string): SecurityWorkflow | null { const row = this.#db.prepare("SELECT definition_json FROM workflow_definitions WHERE id = ?").all(id)[0]; return row ? JSON.parse(String((row as { definition_json: string }).definition_json)) as SecurityWorkflow : null; }
  save(value: unknown): SecurityWorkflow {
    let input;
    try { input = parseSecurityWorkflowInput(value); } catch (error) { throw new SecurityWorkflowStoreError(error instanceof Error ? error.message : "Invalid workflow.", 400); }
    return this.#db.transaction(() => {
      const existing = input.id ? this.get(input.id) : null;
      if (input.id && !existing && input.revision !== undefined) throw new SecurityWorkflowStoreError("Workflow not found.", 404);
      if (existing && input.revision !== existing.revision) throw new SecurityWorkflowStoreError("Workflow changed. Reload before saving.", 409);
      const now = new Date().toISOString();
      const workflow: SecurityWorkflow = { ...input, id: input.id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
      if (existing) this.#db.prepare("UPDATE workflow_definitions SET revision = ?, definition_json = ?, updated_at = ? WHERE id = ?").run(workflow.revision, JSON.stringify(workflow), now, workflow.id);
      else this.#db.prepare("INSERT INTO workflow_definitions (id, revision, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(workflow.id, workflow.revision, JSON.stringify(workflow), now, now);
      return workflow;
    })();
  }
  delete(id: string, revision?: number): boolean {
    return this.#db.transaction(() => { const workflow = this.get(id); if (!workflow) return false; if (revision !== undefined && revision !== workflow.revision) throw new SecurityWorkflowStoreError("Workflow changed. Reload before deleting.", 409); this.#db.prepare("DELETE FROM workflow_definitions WHERE id = ?").run(id); return true; })();
  }
  createExecution(workflowId: string, sessionId: string, revision?: number): SecurityWorkflowExecution {
    if (!sessionId || sessionId.length > 128) throw new SecurityWorkflowStoreError("Invalid execution session.", 400);
    return this.#db.transaction(() => {
      const workflow = this.get(workflowId); if (!workflow) throw new SecurityWorkflowStoreError("Workflow not found.", 404);
      if (revision !== undefined && revision !== workflow.revision) throw new SecurityWorkflowStoreError("Workflow changed. Review it before running.", 409);
      const now = new Date().toISOString();
      const execution: SecurityWorkflowExecution = { id: randomUUID(), workflowId, workflowRevision: workflow.revision, workflow, sessionId, ownerPid: process.pid, runnerInstanceId: this.#runnerInstanceId, status: "queued", nodeResults: {}, createdAt: now, updatedAt: now };
      this.#db.prepare("INSERT INTO workflow_executions (id, workflow_id, workflow_revision, session_id, status, execution_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(execution.id, workflowId, workflow.revision, sessionId, execution.status, JSON.stringify(execution), now, now);
      return execution;
    })();
  }
  /** Execute a pinned template without implicitly saving a reusable definition. */
  createExecutionFromSnapshot(value: unknown, sessionId: string): SecurityWorkflowExecution {
    if (!sessionId || sessionId.length > 128) throw new SecurityWorkflowStoreError("Invalid execution owner.", 400);
    const input = parseSecurityWorkflowInput(value);
    const now = new Date().toISOString();
    const workflow: SecurityWorkflow = { ...input, id: input.id ?? randomUUID(), revision: input.revision ?? 1, createdAt: now, updatedAt: now };
    const execution: SecurityWorkflowExecution = { id: randomUUID(), workflowId: workflow.id, workflowRevision: workflow.revision, workflow, sessionId, ownerPid: process.pid, runnerInstanceId: this.#runnerInstanceId, status: "queued", nodeResults: {}, createdAt: now, updatedAt: now };
    this.#db.prepare("INSERT INTO workflow_executions (id, workflow_id, workflow_revision, session_id, status, execution_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(execution.id, execution.workflowId, execution.workflowRevision, sessionId, execution.status, JSON.stringify(execution), now, now);
    return execution;
  }
  getExecution(id: string): SecurityWorkflowExecution | null { const row = this.#db.prepare("SELECT execution_json FROM workflow_executions WHERE id = ?").all(id)[0]; return row ? JSON.parse(String((row as { execution_json: string }).execution_json)) as SecurityWorkflowExecution : null; }
  /** Retain structured evidence independently of process-local job memory. */
  saveExecutionResults(id: string, result: unknown): void {
    if (!this.getExecution(id)) throw new SecurityWorkflowStoreError("Execution not found.", 404);
    const json = JSON.stringify(result);
    if (json === undefined || Buffer.byteLength(json, "utf8") > 16 * 1024 * 1024) throw new SecurityWorkflowStoreError("Workflow results must be valid JSON of at most 16 MiB.", 400);
    this.#db.prepare("INSERT INTO workflow_execution_results (execution_id, result_json) VALUES (?, ?) ON CONFLICT(execution_id) DO UPDATE SET result_json = excluded.result_json").run(id, json);
  }
  getExecutionResults(id: string): unknown | null {
    const row = this.#db.prepare("SELECT result_json FROM workflow_execution_results WHERE execution_id = ?").all(id)[0];
    return row ? JSON.parse(String((row as { result_json: string }).result_json)) : null;
  }
  listExecutions(workflowId?: string, sessionId?: string): SecurityWorkflowExecution[] {
    return this.#db.prepare("SELECT execution_json FROM workflow_executions WHERE (? IS NULL OR workflow_id = ?) AND (? IS NULL OR session_id = ?) ORDER BY created_at DESC, id LIMIT 200").all(workflowId ?? null, workflowId ?? null, sessionId ?? null, sessionId ?? null).map(row => JSON.parse(String((row as { execution_json: string }).execution_json)) as SecurityWorkflowExecution);
  }
  updateExecution(id: string, update: SecurityWorkflowExecutionUpdate): SecurityWorkflowExecution {
    return this.#db.transaction(() => {
      const current = this.getExecution(id); if (!current) throw new SecurityWorkflowStoreError("Execution not found.", 404);
      if (!activeStatuses[current.status]) throw new SecurityWorkflowStoreError("Execution is already finished.", 409);
      if (update.status !== undefined && (!Object.hasOwn(statuses, update.status) || (current.status === "running" && update.status === "queued"))) throw new SecurityWorkflowStoreError("Invalid execution status transition.", 400);
      if (update.jobId !== undefined && (typeof update.jobId !== "string" || update.jobId.length > 128)) throw new SecurityWorkflowStoreError("Invalid execution job ID.", 400);
      if (update.error !== undefined && (typeof update.error !== "string" || update.error.length > 16_000)) throw new SecurityWorkflowStoreError("Invalid execution error.", 400);
      if (update.nodeResults !== undefined) {
        const nodeIds = new Set(current.workflow.nodes.map(node => node.id));
        if (!update.nodeResults || typeof update.nodeResults !== "object" || Array.isArray(update.nodeResults) || JSON.stringify(update.nodeResults).length > 100_000 || Object.entries(update.nodeResults).some(([key, result]) => {
          if (!nodeIds.has(key) || !result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "status") || typeof result.status !== "string" || !result.status.length || result.status.length > 64) return true;
          if (Object.keys(result).some(field => !["status", "jobId", "scanId", "scanIds", "dbPaths", "error"].includes(field))) return true;
          if ([result.jobId, result.scanId].some(value => value !== undefined && (typeof value !== "string" || value.length > 128))) return true;
          if (result.error !== undefined && (typeof result.error !== "string" || result.error.length > 16_000)) return true;
          return [result.scanIds, result.dbPaths].some(values => values !== undefined && (!Array.isArray(values) || values.length > 64 || values.some(value => typeof value !== "string" || value.length > 4096)));
        })) throw new SecurityWorkflowStoreError("Invalid execution node results.", 400);
      }
      const execution: SecurityWorkflowExecution = { ...current, status: update.status ?? current.status, jobId: update.jobId ?? current.jobId, nodeResults: update.nodeResults ?? current.nodeResults, error: update.error ?? current.error, updatedAt: new Date().toISOString() };
      this.#db.prepare("UPDATE workflow_executions SET status = ?, execution_json = ?, updated_at = ? WHERE id = ?").run(execution.status, JSON.stringify(execution), execution.updatedAt, id);
      return execution;
    })();
  }
  interruptActiveExecutions(isOwnerAlive: (pid: number) => boolean = processAlive): number {
    const rows = this.#db.prepare("SELECT execution_json FROM workflow_executions WHERE status IN ('queued', 'running')").all();
    let interrupted = 0;
    for (const row of rows) {
      const execution = JSON.parse(String((row as { execution_json: string }).execution_json)) as SecurityWorkflowExecution;
      // Unknown legacy owners and live/PID-reused owners are conservatively retained.
      if (!Number.isInteger(execution.ownerPid) || execution.ownerPid <= 0 || isOwnerAlive(execution.ownerPid)) continue;
      try {
        this.updateExecution(execution.id, { status: "interrupted", error: "The local engine stopped. Run this workflow again to continue." });
        interrupted++;
      } catch (error) {
        if (!(error instanceof SecurityWorkflowStoreError && error.statusCode === 409)) throw error;
      }
    }
    return interrupted;
  }
  close(): void { this.#db.close(); }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}
