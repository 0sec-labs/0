import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { SecurityWorkflowBindingsSchema, type SecurityWorkflowExecution, type ScanPlan } from "@0/shared";
import { ConsoleGateway } from "./web/console-gateway.js";
import { WebWorkflowService } from "./web/workflows.js";
import { WorkflowEngineService } from "./workflow-engine-service.js";
import { connectLocalEngine } from "./local-engine.js";

export interface CliWorkflowRuntimeOptions {
  ownerId: string;
  /** Hosted servers recover shared history once before accepting requests. */
  recoverInterrupted?: boolean;
  workspace?: string;
  target?: string;
  scopePath?: string;
  dbPath?: string;
  model?: string;
  timeCapMs?: number;
  costCapUsd?: number;
  /** Host permission; a run must independently request application. */
  allowApply?: boolean;
}
export interface StartWorkflowRun {
  sessionId?: string;
  templateId?: string;
  workflowId?: string;
  revision?: number;
  target: string;
  idempotencyKey?: string;
  model?: string;
  timeCapMs?: number;
  costCapUsd?: number;
  inputs?: Record<string, unknown>;
  allowApply?: boolean;
}
/** Inject an existing engine host. Detaching this client never disposes that host. */
export interface CliWorkflowDependencies {
  host?: { gateway: ConsoleGateway; workflows: WebWorkflowService };
}

/** Bindings are data, never portable approvals or executable graph code. */
export function parseWorkflowRunInputs(value: unknown): Record<string, unknown> {
  return structuredClone(SecurityWorkflowBindingsSchema.parse(value ?? {}));
}

/** Embedded transport over the same engine host used by the browser API. */
export async function createCliWorkflowRuntime(options: CliWorkflowRuntimeOptions, dependencies: CliWorkflowDependencies = {}) {
  if (!options.ownerId || options.ownerId.length > 128) throw new Error("A workflow runtime requires a valid owner.");
  if (options.workspace && !isAbsolute(options.workspace)) throw new Error("The authorized workspace must be an absolute path.");
  const workspace = options.workspace ? await realpath(options.workspace) : await realpath(process.cwd());
  if (!dependencies.host) {
    const existing = await connectLocalEngine({ ...options, workspace });
    if (existing) {
      return { ...existing, startRun: (request: StartWorkflowRun) => {
        if (options.target && request.target.trim() !== options.target.trim()) return Promise.reject(new Error("Target does not match this workflow client's configured target."));
        const timeCapMs = request.timeCapMs === undefined ? options.timeCapMs : options.timeCapMs === undefined ? request.timeCapMs : Math.min(request.timeCapMs, options.timeCapMs);
        const costCapUsd = request.costCapUsd === undefined ? options.costCapUsd : options.costCapUsd === undefined ? request.costCapUsd : Math.min(request.costCapUsd, options.costCapUsd);
        return existing.startRun({ ...request, ...(timeCapMs !== undefined ? { timeCapMs } : {}), ...(costCapUsd !== undefined ? { costCapUsd } : {}) });
      } };
    }
  }
  const ownsHost = !dependencies.host;
  const gateway = dependencies.host?.gateway ?? new ConsoleGateway({ projectPath: workspace, dbPath: options.dbPath });
  const workflows = dependencies.host?.workflows ?? new WebWorkflowService({ gateway, dbPath: options.dbPath, recoverInterrupted: options.recoverInterrupted });
  if (ownsHost) gateway.attachWorkflowLifecycle({ invoke: (sessionId, name, args, capabilities) => workflows.invokeLifecycle(sessionId, name, args, capabilities) });
  let engine: WorkflowEngineService;
  try {
    engine = new WorkflowEngineService({
    token: randomBytes(32).toString("hex"), workspace, target: options.target,
    scopePath: options.scopePath, dbPath: options.dbPath, model: options.model,
    timeCapMs: options.timeCapMs, costCapUsd: options.costCapUsd, allowApply: options.allowApply,
    }, { gateway, workflows });
    await engine.ready;
  } catch (error) {
    if (ownsHost) { try { await workflows.dispose(); } finally { await gateway.closeAll(); } }
    throw error;
  }
  let disposed = false;
  const invoke = (name: string, args: Record<string, unknown> = {}) => {
    if (disposed) return Promise.reject(new Error("Workflow runtime is shutting down."));
    return engine.invoke(name, args);
  };
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
    startAssessment: (request: { sessionId?: string; target: string; plan: ScanPlan }): Promise<SecurityWorkflowExecution> => invoke("start_assessment", { ...request }) as Promise<SecurityWorkflowExecution>,
    startRun: (request: StartWorkflowRun): Promise<SecurityWorkflowExecution> => {
      if (request.model !== undefined && request.model !== options.model) return Promise.reject(new Error("Configure the embedded engine model before starting this workflow."));
      const { model: _model, ...args } = request;
      return invoke("start_run", args) as Promise<SecurityWorkflowExecution>;
    },
    getRun: (id: string): Promise<SecurityWorkflowExecution | null> => invoke("get_run", { runId: id }) as Promise<SecurityWorkflowExecution | null>,
    getRunResults: (id: string, page: { cursor?: number; limit?: number } = {}) => invoke("get_run_results", { runId: id, ...page }),
    cancelRun: (id: string) => invoke("cancel_run", { runId: id }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await engine.dispose();
      if (ownsHost) { try { await workflows.dispose(); } finally { await gateway.closeAll(); } }
    },
  };
}
