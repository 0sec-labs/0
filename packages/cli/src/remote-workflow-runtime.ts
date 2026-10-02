import { z } from "zod";
import { BackendIdSchema, requireBackendCapability, type BackendDescriptor, type SecurityWorkflowExecution, type ScanPlan } from "@0/shared";
import type { StartWorkflowRun } from "./workflow-runtime.js";

export interface RemoteWorkflowRuntimeOptions { backendId?: string; configPath?: string; engineUrl?: string; engineTokenEnv?: string; sessionId?: string }
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
  if (options.engineUrl && (options.backendId || options.configPath)) throw new Error("--engine-url cannot be combined with a registered backend.");
  if (Boolean(options.engineUrl) !== Boolean(options.engineTokenEnv)) throw new Error("Direct engine attachment requires both --engine-url and --engine-token-env.");
  const backendId = BackendIdSchema.parse(options.backendId ?? (options.engineUrl ? "attached-engine" : undefined));
  const registry = suppliedRegistry ?? new (await import("./web/backend-connections.js")).BackendConnectionRegistry(options.engineUrl
    ? { connections: [{ id: backendId, name: "Attached engine", url: options.engineUrl, bearerTokenEnv: options.engineTokenEnv! }] }
    : { configPath: options.configPath });
  try {
    const connection = await registry.handshake(backendId);
    if (connection.backend.transport !== "http") throw new Error("Select a registered remote HTTP backend; local execution cannot use this transport.");
    requireBackendCapability(connection.backend, "workflow-engine");
  } catch (error) { if (!suppliedRegistry) registry.dispose?.(); throw error; }
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
  if (options.sessionId !== undefined) {
    try {
      z.string().trim().min(1).max(160).parse(options.sessionId);
      const session = await invoke("attach_session", { sessionId: options.sessionId });
      if (!session) throw new Error("The selected engine session no longer exists.");
    } catch (error) { if (!suppliedRegistry) registry.dispose?.(); throw error; }
  }
  return {
    getCapabilities: () => invoke("get_capabilities"),
    resumeScan: (request: { sessionId: string; scanId: string; branchFromEntry?: number; timeCapMs?: number; costCapUsd?: number }) => invoke("resume_scan", request),
    listSessions: () => invoke("list_sessions"),
    createSession: (config?: Record<string, unknown>) => invoke("create_session", config ? { config } : {}),
    attachSession: (sessionId: string) => invoke("attach_session", { sessionId }),
    getSessionEvents: (sessionId: string, after?: number) => invoke("get_session_events", { sessionId, ...(after !== undefined ? { after } : {}) }),
    getSession: (sessionId: string) => invoke("get_session", { sessionId }),
    sendMessage: (sessionId: string, text: string) => invoke("send_message", { sessionId, text }),
    continueSession: (sessionId: string, text?: string) => invoke("continue_session", { sessionId, ...(text !== undefined ? { text } : {}) }),
    cancelSession: (sessionId: string) => invoke("cancel_session", { sessionId }),
    resolveDecision: (sessionId: string, decisionId: string, response: Record<string, unknown>) => invoke("resolve_decision", { sessionId, decisionId, response }),
    listSavedSessions: () => invoke("list_saved_sessions"),
    resumeSession: (savedSessionId: string) => invoke("resume_session", { savedSessionId }),
    listTemplates: () => invoke("list_templates"),
    getTemplate: (id: string) => invoke("get_template", { id }),
    listWorkflows: () => invoke("list_workflows"),
    listRuns: () => invoke("list_runs"),
    getWorkflow: (id: string) => invoke("get_workflow", { id }),
    saveWorkflow: (definition: unknown, expectedRevision?: number) => invoke("save_workflow", { definition, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
    startAssessment: async (request: { sessionId?: string; target: string; plan: ScanPlan }): Promise<SecurityWorkflowExecution> =>
      executionSchema.parse(await invoke("start_assessment", { ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...request })) as unknown as SecurityWorkflowExecution,
    startRun: async (request: StartWorkflowRun & { sessionId?: string }): Promise<SecurityWorkflowExecution> => {
      if (request.model !== undefined) throw new Error("The selected backend owns its configured model connection.");
      const { model: _model, ...args } = request;
      return executionSchema.parse(await invoke("start_run", { ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...args })) as unknown as SecurityWorkflowExecution;
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
