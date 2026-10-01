import { z } from "zod";
import { BackendIdSchema, requireBackendCapability, type BackendDescriptor, type SecurityWorkflowExecution } from "@0/shared";
import type { StartWorkflowRun } from "./workflow-runtime.js";

export interface RemoteWorkflowRuntimeOptions { backendId: string; configPath?: string }
interface Registry {
  dispose?(): void;
  handshake(id: string): Promise<{ backend: BackendDescriptor; error?: string }>;
  request(id: string, path: string, options: { method: string; body: unknown; signal: AbortSignal }): Promise<Response>;
}
const executionSchema = z.object({ id: z.string().min(1).max(160), status: z.enum(["queued", "running", "completed", "failed", "cancelled", "interrupted"]) }).passthrough();
async function readJson(response: Response): Promise<unknown> {
  const maximum = 16 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximum) throw new Error("Workflow backend response exceeds 16 MiB.");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error(`Workflow backend returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value ? (value as { error: unknown }).error : undefined;
    throw new Error(typeof error === "string" ? error.slice(0, 4096) : `Workflow backend request failed (HTTP ${response.status}).`);
  }
  return value;
}

/** Targets, paths, provider selection and application permission stay with the configured engine. */
export async function createRemoteWorkflowRuntime(options: RemoteWorkflowRuntimeOptions, suppliedRegistry?: Registry) {
  const backendId = BackendIdSchema.parse(options.backendId);
  const registry = suppliedRegistry ?? new (await import("./web/backend-connections.js")).BackendConnectionRegistry({ configPath: options.configPath });
  const connection = await registry.handshake(backendId);
  if (connection.backend.transport !== "http") throw new Error("Select a registered remote HTTP backend; local execution cannot use this transport.");
  requireBackendCapability(connection.backend, "workflow-engine");
  let disposed = false;
  const active = new Set<AbortController>();
  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (disposed) throw new Error("Remote workflow client is closed.");
    const abort = new AbortController();
    active.add(abort);
    const timeout = setTimeout(() => abort.abort(new Error("Workflow backend request timed out.")), 30_000);
    try { return await readJson(await registry.request(backendId, "/api/workflow-engine/call", { method: "POST", body: { name, args }, signal: abort.signal })); }
    finally { clearTimeout(timeout); active.delete(abort); }
  };
  return {
    listTemplates: () => invoke("list_templates"),
    getTemplate: (id: string) => invoke("get_template", { id }),
    listWorkflows: () => invoke("list_workflows"),
    listRuns: () => invoke("list_runs"),
    getWorkflow: (id: string) => invoke("get_workflow", { id }),
    saveWorkflow: (definition: unknown, expectedRevision?: number) => invoke("save_workflow", { definition, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
    startRun: async (request: StartWorkflowRun): Promise<SecurityWorkflowExecution> => {
      if (request.model !== undefined) throw new Error("The selected backend owns its configured model connection.");
      const { model: _model, ...args } = request;
      return executionSchema.parse(await invoke("start_run", args)) as unknown as SecurityWorkflowExecution;
    },
    getRun: async (id: string): Promise<SecurityWorkflowExecution | null> => {
      const result = await invoke("get_run", { runId: id });
      return result === null ? null : executionSchema.parse(result) as unknown as SecurityWorkflowExecution;
    },
    getRunResults: (id: string, page: { cursor?: number; limit?: number } = {}) => invoke("get_run_results", { runId: id, ...page }),
    cancelRun: (id: string) => invoke("cancel_run", { runId: id }),
    dispose: async () => { if (disposed) return; disposed = true; for (const abort of active) abort.abort(); active.clear(); if (!suppliedRegistry) registry.dispose?.(); },
  };
}
