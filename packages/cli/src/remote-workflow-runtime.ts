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
class BackendRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
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
    throw new BackendRequestError(typeof error === "string" ? error.slice(0, 4096) : `Workflow backend request failed (HTTP ${response.status}).`, response.status);
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
  const request = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    if (disposed) throw new Error("Remote workflow client is closed.");
    const abort = new AbortController();
    active.add(abort);
    const timeout = setTimeout(() => abort.abort(new Error("Workflow backend request timed out.")), 30_000);
    try { return await readJson(await registry.request(backendId, path, { method, body, signal: abort.signal })); }
    finally { clearTimeout(timeout); active.delete(abort); }
  };
  const invoke = (name: string, args: Record<string, unknown> = {}) => request("/api/workflow-engine/call", "POST", { name, args });
  const workerPath = (sessionId: string, workerId?: string) => {
    const id = z.string().trim().min(1).max(160).refine(value => value !== "." && value !== "..", "Invalid identifier.");
    const session = id.parse(sessionId);
    const worker = workerId === undefined ? undefined : id.parse(workerId);
    // The existing route reserves /workers/stop for stopping every worker.
    if (worker === "stop") throw new Error("Invalid worker identifier.");
    return `/api/console/sessions/${encodeURIComponent(session)}/workers${worker === undefined ? "" : `/${encodeURIComponent(worker)}`}`;
  };
  // Resolve only already-live sessions. Never restore a snapshot or cache a live ID:
  // a saved reference can point at a replacement live session after a reconnect.
  const liveSnapshot = z.object({ session: z.object({ id: z.string().min(1).max(160), status: z.string().min(1) }) }).passthrough();
  const attachExistingSession = async (reference: string): Promise<unknown> => {
    let originalError: unknown;
    try {
      const value = await invoke("attach_session", { sessionId: reference });
      if (!value) throw new Error("The selected engine session no longer exists.");
      const attached = liveSnapshot.parse(value);
      if (attached.session.status !== "closed") return attached;
      originalError = new Error("The selected engine session is closed.");
    } catch (error) {
      // Only a missing/closed reference is eligible for saved-alias recovery.
      // Authentication, transport and malformed snapshot failures stay intact.
      if (!(error instanceof BackendRequestError) || error.status !== 404) throw error;
      originalError = error;
    }
    const listed = await invoke("list_sessions");
    const sessions = z.array(z.object({ id: z.string(), savedId: z.string().optional(), status: z.string().min(1) }).passthrough()).parse(listed);
    const matches = sessions.filter(session => session.status !== "closed" && (session.id === reference || session.savedId === reference));
    if (matches.length !== 1) throw originalError;
    const attached = liveSnapshot.parse(await invoke("attach_session", { sessionId: matches[0]!.id }));
    if (attached.session.status === "closed") throw new Error("The selected engine session closed while attaching.");
    return attached;
  };
  const liveWorkerPath = async (reference: string, workerId?: string) => {
    workerPath(reference, workerId);
    const attached = await attachExistingSession(reference);
    const snapshot = z.object({ session: z.object({ id: z.string().min(1).max(160) }) }).parse(attached);
    return workerPath(snapshot.session.id, workerId);
  };
  if (options.sessionId !== undefined) {
    try {
      z.string().trim().min(1).max(160).parse(options.sessionId);
      const session = await attachExistingSession(options.sessionId);
      if (!session) throw new Error("The selected engine session no longer exists.");
    } catch (error) { if (!suppliedRegistry) registry.dispose?.(); throw error; }
  }
  return {
    getCapabilities: () => invoke("get_capabilities"),
    resumeScan: (request: { sessionId: string; scanId: string; branchFromEntry?: number; timeCapMs?: number; costCapUsd?: number }) => invoke("resume_scan", request),
    listSessions: () => invoke("list_sessions"),
    listSessionWorkers: async (sessionId: string) => request(await liveWorkerPath(sessionId), "GET"),
    getSessionWorker: async (sessionId: string, workerId: string) => {
      z.string().trim().min(1).max(160).parse(workerId);
      const result = await request(await liveWorkerPath(sessionId), "GET") as { workers?: Array<{ id: string }> };
      const worker = result.workers?.find(worker => worker.id === workerId);
      if (!worker) throw new Error("Worker does not belong to this session.");
      return { worker };
    },
    sendSessionWorkerMessage: async (sessionId: string, workerId: string, text: string) => {
      const body = { text: z.string().trim().min(1).max(8000).parse(text) };
      return request(`${await liveWorkerPath(sessionId, workerId)}/messages`, "POST", body);
    },
    stopSessionWorker: async (sessionId: string, workerId: string) => request(`${await liveWorkerPath(sessionId, workerId)}/stop`, "POST", {}),
    createSession: (config?: Record<string, unknown>) => invoke("create_session", config ? { config } : {}),
    attachSession: (sessionId: string) => attachExistingSession(sessionId),
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
