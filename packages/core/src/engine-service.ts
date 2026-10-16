import { z } from "zod";
import { SecurityWorkflowBindingsSchema, createEngineCapabilityManifest, type SecurityWorkflowExecution } from "@0/shared";

const id = z.string().trim().min(1).max(160);
const empty = z.object({}).strict();
const session = z.object({ sessionId: id }).strict();
const run = z.object({ runId: id, cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const EngineStartRunSchema = z.object({
  sessionId: id.optional(), templateId: id.optional(), workflowId: id.optional(), revision: z.number().int().positive().optional(),
  target: z.string().trim().min(1).max(4096), inputs: SecurityWorkflowBindingsSchema.optional(), idempotencyKey: id.optional(),
  allowApply: z.boolean().optional(), timeCapMs: z.number().int().positive().max(86_400_000).optional(), costCapUsd: z.number().positive().max(1000).optional(),
}).strict();
export type EngineStartRun = z.infer<typeof EngineStartRunSchema>;
export const EngineAssessmentPlanSchema = z.object({ goal: z.enum(["known-vulnerabilities", "unknown-vulnerabilities", "misconfigurations"]), depth: z.enum(["quick", "default", "deep"]), runCount: z.number().int().min(1).max(16), executionMode: z.enum(["sequential", "parallel"]), timeCapMs: z.number().int().positive().max(86_400_000), costCapUsd: z.number().positive().max(1000) }).strict();
export const EngineAssessmentSchema = z.object({ sessionId: id.optional(), target: z.string().trim().min(1).max(4096), plan: EngineAssessmentPlanSchema }).strict();

/** Host services own execution and authority. Transports exchange JSON only. */
export interface EngineSessionPort {
  list(): unknown;
  create(config?: unknown): { id: string };
  get(id: string): unknown;
  send(id: string, input: { text: string }): unknown | Promise<unknown>;
  continue(id: string, input: { text?: string }): unknown | Promise<unknown>;
  cancel(id: string): unknown | Promise<unknown>;
  resolveDecision(id: string, decisionId: string, response: unknown): unknown;
  listSaved(): unknown;
  resume(id: string): unknown | Promise<unknown>;
  eventsAfter(id: string, after?: number): unknown;
}
export interface EngineWorkflowPort {
  invokeLifecycle(sessionId: string, name: string, args: Record<string, unknown>, capabilities?: { allowApply?: boolean }): Promise<unknown>;
  getExecution(id: string): SecurityWorkflowExecution | null;
  listExecutions(): SecurityWorkflowExecution[];
}
export interface EngineServiceOptions {
  sessions: EngineSessionPort;
  workflows: EngineWorkflowPort;
  /** Resolves/authorizes an engine-owned session, never a caller-supplied owner. */
  admitRun(request: EngineStartRun): Promise<string>;
  allowApply?: boolean;
  createSession?(config: Record<string, unknown>): { id: string } | Promise<{ id: string }>;
  startAssessment?(sessionId: string, request: z.infer<typeof EngineAssessmentSchema>): Promise<SecurityWorkflowExecution>;
  resumeScan?(request: Record<string, unknown>): Promise<unknown>;
  capabilities?: () => unknown;
}

/** One API over the engine's existing chat and workflow lifecycle, for every interface. */
export class EngineService {
  constructor(private readonly options: EngineServiceOptions) {}
  async invoke(name: string, raw: Record<string, unknown>): Promise<unknown> {
    const { sessions, workflows } = this.options;
    if (name === "get_capabilities") { empty.parse(raw); return this.options.capabilities?.() ?? createEngineCapabilityManifest({ operations: [...ENGINE_OPERATIONS, ...(this.options.startAssessment ? ["start_assessment" as const] : []), ...(this.options.resumeScan ? ["resume_scan" as const] : [])] }); }
    if (name === "list_sessions") { empty.parse(raw); return sessions.list(); }
    if (name === "create_session") {
      const { config } = z.object({ config: z.record(z.unknown()).optional() }).strict().parse(raw);
      return this.options.createSession ? this.options.createSession(config ?? {}) : sessions.create(config);
    }
    if (name === "get_session" || name === "attach_session") return sessions.get(session.parse(raw).sessionId);
    if (name === "send_message") { const request = z.object({ sessionId: id, text: z.string().min(1).max(2_000_000) }).strict().parse(raw); return sessions.send(request.sessionId, { text: request.text }); }
    if (name === "continue_session") { const request = z.object({ sessionId: id, text: z.string().min(1).max(2_000_000).optional() }).strict().parse(raw); return sessions.continue(request.sessionId, { text: request.text }); }
    if (name === "cancel_session") return sessions.cancel(session.parse(raw).sessionId);
    if (name === "resolve_decision") { const request = z.object({ sessionId: id, decisionId: id, response: z.record(z.unknown()) }).strict().parse(raw); return sessions.resolveDecision(request.sessionId, request.decisionId, request.response); }
    if (name === "list_saved_sessions") { empty.parse(raw); return sessions.listSaved(); }
    if (name === "resume_session") return sessions.resume(z.object({ savedSessionId: id }).strict().parse(raw).savedSessionId);
    if (name === "get_session_events") { const request = session.extend({ after: z.number().int().nonnegative().optional() }).parse(raw); return sessions.eventsAfter(request.sessionId, request.after); }
    if (name === "resume_scan") {
      const request = z.object({ sessionId: id, scanId: id, branchFromEntry: z.number().int().nonnegative().optional(), timeCapMs: z.number().int().positive().max(86_400_000).optional(), costCapUsd: z.number().positive().max(1000).optional() }).strict().parse(raw);
      if (!this.options.resumeScan) throw new Error("This engine does not support persisted scan resume.");
      return this.options.resumeScan(request);
    }
    if (name === "list_runs") { empty.parse(raw); return workflows.listExecutions(); }
    if (name === "start_assessment") {
      const request = EngineAssessmentSchema.parse(raw);
      if (!this.options.startAssessment) throw new Error("This engine does not support assessments.");
      const sessionId = await this.options.admitRun(request);
      return this.options.startAssessment(sessionId, request);
    }
    if (name === "start_run") {
      const request = EngineStartRunSchema.parse(raw);
      if (Boolean(request.templateId) === Boolean(request.workflowId)) throw new Error("Select exactly one templateId or workflowId.");
      if (request.workflowId && !request.revision) throw new Error("Saved workflow runs require a pinned revision.");
      if (request.allowApply && !this.options.allowApply) throw new Error("This engine does not authorize applying fixes.");
      const sessionId = await this.options.admitRun(request);
      const { sessionId: _sessionId, ...args } = request;
      const started = await workflows.invokeLifecycle(sessionId, name, args, { allowApply: this.options.allowApply === true }) as { runId: string };
      const execution = workflows.getExecution(started.runId);
      if (!execution) throw new Error("Engine did not retain the launched workflow.");
      return execution;
    }
    if (["get_run", "get_run_results", "cancel_run"].includes(name)) {
      const request = run.parse(raw);
      const execution = workflows.getExecution(request.runId);
      if (!execution) throw new Error("Workflow run was not found in this engine.");
      const result = await workflows.invokeLifecycle(execution.sessionId, name, request, { allowApply: this.options.allowApply });
      if (name === "get_run") { const response = result as { run: Record<string, unknown>; events?: unknown }; return { ...response.run, ...(response.events !== undefined ? { events: response.events } : {}) }; }
      if (name === "cancel_run") return { ...workflows.getExecution(request.runId), ...((result as { cancellationRequested?: boolean }).cancellationRequested ? { cancellationRequested: true } : {}) };
      return result;
    }
    if (["list_templates", "get_template", "list_workflows", "get_workflow", "save_workflow"].includes(name)) {
      // Definition operations do not allocate a model session or start execution.
      const result = await workflows.invokeLifecycle("engine-definitions", name, raw) as Record<string, unknown>;
      return result.templates ?? result.template ?? result.workflows ?? result.workflow;
    }
    throw new Error("Unknown engine operation.");
  }
}

export const ENGINE_OPERATIONS = ["get_capabilities", "list_sessions", "create_session", "attach_session", "get_session", "send_message", "continue_session", "cancel_session", "resolve_decision", "list_saved_sessions", "resume_session", "get_session_events", "list_templates", "get_template", "list_workflows", "get_workflow", "save_workflow", "start_run", "list_runs", "get_run", "get_run_results", "cancel_run"] as const;
