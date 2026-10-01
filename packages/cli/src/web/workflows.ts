import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { validateScanPlan, SECURITY_WORKFLOW_TEMPLATES, createSecurityWorkflowTemplate, isSecurityWorkflowOperation, SecurityWorkflowBindingsSchema, getSecurityWorkflowTemplate, checkSecurityWorkflowTemplateTarget, DEFAULT_SECURITY_WORKFLOW_PLAN, parseSecurityWorkflowInput, type Finding, type ScanReport, type SecurityWorkflow, type SecurityWorkflowNode, type SecurityWorkflowExecution } from "@0/shared";
import { SecurityWorkflowStore } from "@0/db";
import {
  executeWorkflow,
  orderWorkflowNodes,
  type WorkflowAssessmentContext,
  type WorkflowExecutorRegistry,
  type WorkflowRunResult,
  applySourceFixCandidate,
  loadSourceFixProjectInputs,
  planSourceFixPublication,
  publishSourceFixDraftPR,
  resolveSourceFixRepository,
  runSourceFix,
  saveSourceFixProjectInputs,
  verifySourceFixCandidate,
  withScopeEnforcement,
  LlmApiRuntime,
  withWorkflowAuditExecutionPolicy, assertWorkflowNativeRuntime, workflowPolicyRuntime, getToolsForRole,
  type NativeRuntime,
  type ScopeEnforcementState,
  type ScopePolicy,
  type SourceFixPublicationPlan,
  type SourceFixResult,
  type LearningServiceOptions,
} from "@0/core";
import { runUnified, type RunOutcome } from "../commands/run.js";
import { resolveEngagement } from "../engagement-plan.js";
import { loadFindingFocus } from "../finding-focus.js";
import { fixEligibility } from "../tui/fix-action.js";
import { createResearchWorkflowExecutors, validateResearchWorkflowInputs } from "../workflow-research-executors.js";
import { type FindingCandidateStore, createFindingCandidateStore, createFindingWorkflowExecutors, validateFindingWorkflowInputs } from "../finding-workflow-executors.js";
import { WebLearningService } from "./learning.js";

const execFileAsync = promisify(execFile);
const PREFIX = "/api/console/";
const MAX_JOBS = 40;
const MAX_FIXES = 24;
const MAX_ACTIVE = 8;
const MAX_EVENTS = 200;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const idSchema = z.string().trim().min(1).max(160);
const planSchema = z.object({
  goal: z.enum(["known-vulnerabilities", "unknown-vulnerabilities", "misconfigurations"]),
  depth: z.enum(["quick", "default", "deep"]),
  runCount: z.number().int().min(1).max(16),
  executionMode: z.enum(["sequential", "parallel"]),
  timeCapMs: z.number().int().min(1).max(RETENTION_MS),
  costCapUsd: z.number().positive().max(1000),
}).strict();
const launchSchema = z.object({
  sessionId: idSchema,
  target: z.string().trim().min(1).max(4096),
  plan: planSchema,
  approval: z.literal("launch-authorized-run"),
}).strict();
const prepareSchema = z.object({
  sessionId: idSchema,
  findingId: idSchema,
  repoRoot: z.string().trim().min(1).max(4096).optional(),
  testCommand: z.string().trim().min(1).max(4096).optional(),
}).strict();
const fixActionSchema = z.object({
  sessionId: idSchema,
  fixId: idSchema,
  reviewToken: z.string().max(128).optional(),
  candidateId: z.string().max(128).optional(),
  publicationToken: z.string().max(128).optional(),
  approval: z.enum(["generate-and-test", "run-regression", "apply-to-repository", "publish-draft-pr"]).optional(),
}).strict();
const cancelSchema = z.object({ sessionId: idSchema }).strict();
const definitionRunSchema = z.object({ sessionId: idSchema, revision: z.number().int().positive(), approval: z.literal("launch-authorized-run") }).strict();

/** Server-only account/runtime data. Only the explicitly projected selection reaches HTTP. */
export interface WebWorkflowExecutionContext {
  runtime: NativeRuntime;
  model: string;
  providerId: string;
  agentModels?: Record<string, string>;
  singleModel?: boolean;
  autoRoute?: boolean;
  target: string;
  scope?: ScopePolicy;
  scopeEnforcement: ScopeEnforcementState;
  localScopePath?: string;
  status: string;
  role?: string;
  autonomyMode?: string;
  dbPath?: string;
}

export interface WebWorkflowGateway {
  getExecutionContext(id: string): Promise<WebWorkflowExecutionContext>;
  authorizeWorkflowTarget(
    id: string,
    target: { target: string; kind: string },
    signal?: AbortSignal,
    ownerId?: string,
    options?: { interactive?: boolean },
  ): Promise<WebWorkflowExecutionContext>;
}

export interface WebWorkflowEvent {
  sequence: number;
  timestamp: string;
  type: "progress" | "report" | "state" | "error";
  data: unknown;
}

export interface WebWorkflow {
  id: string;
  sessionId: string;
  kind: "run" | "workflow" | "fix-propose" | "fix-verify" | "fix-apply" | "fix-publish";
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  request: unknown;
  runtime: { providerId: string; model: string; agentModels?: Record<string, string>; singleModel?: boolean; autoRoute?: boolean };
  events: WebWorkflowEvent[];
  oldestSequence: number;
  eventsTruncated: boolean;
  runs?: Array<{ scanId: string; runIndex?: number }>;
  report?: ScanReport;
  reportRetained: boolean;
  reportRetentionReason?: string;
  outcome?: Omit<RunOutcome, "report">;
  result?: { fix: WebFix };
  error?: string;
  executionId?: string;
}

export interface WebFix {
  id: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  finding: Finding;
  repoRoot: string;
  baseCommit: string;
  testCommand: string;
  reviewToken: string;
  eligible: boolean;
  reason?: string;
  candidateId?: string;
  result?: SourceFixResult;
  verification?: SourceFixResult;
  applied: boolean;
  application?: SourceFixResult;
  publication?: SourceFixPublicationPlan & { publicationToken: string };
  published?: { prUrl: string; branch: string; worktree: string };
  activeWorkflowId?: string;
}

interface ManagedJob {
  view: WebWorkflow;
  controller: AbortController;
  sequence: number;
  reportBytes: number;
  settledAt?: number;
  promise?: Promise<void>;
}
interface ManagedFix {
  view: WebFix;
  dbPath: string;
  findingIdentity: string;
  context: WebWorkflowExecutionContext;
  /** Keep original object identity: core's WeakMap proves this candidate was actually verified. */
  candidate?: SourceFixResult;
}

class WorkflowError extends Error {
  constructor(message: string, readonly status: number = 409) { super(message); }
}
function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function snapshot<T>(value: T): T { return structuredClone(value); }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new WorkflowError(result.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "), 400);
  return result.data;
}
function active(job: ManagedJob): boolean {
  return job.view.status === "queued" || job.view.status === "running" || job.view.status === "cancelling";
}
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 16_000); }
function selection(context: WebWorkflowExecutionContext): WebWorkflow["runtime"] {
  return snapshot({ providerId: context.providerId, model: context.model,
    ...(context.agentModels ? { agentModels: context.agentModels } : {}),
    ...(context.singleModel !== undefined ? { singleModel: context.singleModel } : {}),
    ...(context.autoRoute !== undefined ? { autoRoute: context.autoRoute } : {}) });
}
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
async function repositoryState(repoRoot: string): Promise<{ head: string; dirty: boolean }> {
  const options = { cwd: repoRoot, timeout: 5000, maxBuffer: 128 * 1024 };
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], options),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], options),
  ]);
  return { head: head.stdout.trim(), dirty: status.stdout.length > 0 };
}

/** Browser orchestration only: the existing scanners and verified source-fix services own execution. */
export class WebWorkflowService {
  readonly #gateway: WebWorkflowGateway;
  readonly #dbPath?: string;
  readonly #jobs = new Map<string, ManagedJob>();
  readonly #fixes = new Map<string, ManagedFix>();
  readonly #repositoryJobs = new Map<string, string>();
  readonly #definitions: SecurityWorkflowStore;
  readonly learning: WebLearningService;
  readonly #graphJobs = new Map<string, string>();
  readonly #graphConnections = new Map<string, string | null>();
  readonly #workflowCandidates = new Map<string, FindingCandidateStore>();
  readonly #lifecycleKeys = new Map<string, { request: string; promise: Promise<unknown> }>();
  #disposing = false;

  constructor(options: { gateway: WebWorkflowGateway; dbPath?: string; learning?: LearningServiceOptions }) {
    this.#gateway = options.gateway;
    this.#dbPath = options.dbPath;
    this.#definitions = new SecurityWorkflowStore(options.dbPath);
    this.#definitions.interruptActiveExecutions();
    this.learning = new WebLearningService(this.#definitions, options.learning);
  }

  /** Session-owned lifecycle calls; launches require an idle gateway and host capabilities. */
  async invokeLifecycle(sessionId: string, name: string, args: Record<string, unknown>, capabilities: { allowApply?: boolean } = {}): Promise<unknown> {
    parse(idSchema, sessionId);
    if (name === "list_templates") { parse(z.object({}).strict(), args); return { templates: snapshot(SECURITY_WORKFLOW_TEMPLATES) }; }
    if (name === "get_template") { const request = parse(z.object({ id: idSchema, revision: z.number().int().positive().optional() }).strict(), args); return { template: getSecurityWorkflowTemplate(request.id, request.revision) }; }
    if (name === "list_workflows") { parse(z.object({}).strict(), args); return { workflows: this.#definitions.list() }; }
    if (name === "get_workflow") { const request = parse(z.object({ id: idSchema }).strict(), args); const workflow = this.#definitions.get(request.id); if (!workflow) throw new WorkflowError("Workflow definition was not found.", 404); return { workflow }; }
    if (name === "save_workflow") {
      const request = parse(z.object({ definition: z.unknown(), expectedRevision: z.number().int().positive().optional() }).strict(), args);
      const definition = parseSecurityWorkflowInput(request.definition);
      return { workflow: this.#definitions.save({ ...definition, ...(request.expectedRevision ? { revision: request.expectedRevision } : {}) }) };
    }
    if (name === "start_run") {
      const request = parse(z.object({ templateId: idSchema.optional(), workflowId: idSchema.optional(), revision: z.number().int().positive().optional(), target: z.string().trim().min(1).max(4096).optional(),
        inputs: SecurityWorkflowBindingsSchema.optional(), allowApply: z.boolean().optional(), timeCapMs: z.number().int().positive().max(RETENTION_MS).optional(), costCapUsd: z.number().positive().max(1000).optional(), idempotencyKey: idSchema.optional() }).strict(), args);
      if (Boolean(request.templateId) === Boolean(request.workflowId)) throw new WorkflowError("Choose exactly one templateId or workflowId.", 400);
      if (request.allowApply && !capabilities.allowApply) throw new WorkflowError("Repository application requires explicit host approval.", 403);
      const key = request.idempotencyKey ? `${sessionId}:${request.idempotencyKey}` : undefined;
      const digest = identity({ request, allowApply: capabilities.allowApply === true });
      const existing = key ? this.#lifecycleKeys.get(key) : undefined;
      if (existing) { if (existing.request !== digest) throw new WorkflowError("Idempotency key already identifies different run inputs."); return existing.promise; }
      const launch = async () => {
        let definition: SecurityWorkflow;
        if (request.templateId) {
          const template = createSecurityWorkflowTemplate(request.templateId, { target: request.target, revision: request.revision });
          const now = new Date().toISOString();
          definition = { ...template, id: `template-${request.templateId}`, revision: template.template!.revision, createdAt: now, updatedAt: now };
        } else {
          const saved = this.#definitions.get(request.workflowId!);
          if (!saved) throw new WorkflowError("Workflow definition was not found.", 404);
          if (!request.revision || request.revision !== saved.revision) throw new WorkflowError("Select the reviewed workflow revision.");
          definition = { ...saved, ...(request.target ? { target: request.target } : {}) };
        }
        const result = await this.#runDefinition(definition.id, { sessionId, revision: definition.revision, approval: "launch-authorized-run" }, true, definition,
          { inputs: request.inputs as Record<string, unknown> | undefined, allowApply: capabilities.allowApply === true && request.allowApply === true, timeCapMs: request.timeCapMs, costCapUsd: request.costCapUsd });
        const started = result.data as { workflow: WebWorkflow; execution: SecurityWorkflowExecution };
        return { runId: started.execution.id, jobId: started.workflow.id, status: started.execution.status, workflow: started.execution.workflow, runtime: started.workflow.runtime };
      };
      const promise = launch();
      if (key) { this.#lifecycleKeys.set(key, { request: digest, promise }); promise.catch(() => this.#lifecycleKeys.delete(key)); }
      return promise;
    }
    const request = parse(z.object({ runId: idSchema, cursor: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(100).optional() }).strict(), args);
    const execution = this.#definitions.getExecution(request.runId);
    if (!execution || execution.sessionId !== sessionId) throw new WorkflowError("Workflow run was not found for this session.", 404);
    if (name === "get_run") return { run: { ...execution, id: execution.id, ownerId: sessionId } };
    if (name === "get_run_results") {
      const result = this.#definitions.getExecutionResults(execution.id) as WorkflowRunResult | null;
      const cursor = request.cursor ?? 0; const limit = request.limit ?? 50;
      const findings = result?.findings ?? [];
      return { runId: execution.id, status: execution.status, findings: findings.slice(cursor, cursor + limit), totalFindings: findings.length,
        nextCursor: cursor + limit < findings.length ? cursor + limit : null, outputs: result?.outputs ?? [], report: result?.report ? { ...result.report, findings: findings.slice(cursor, cursor + limit) } : undefined };
    }
    if (name === "cancel_run") {
      const jobId = this.#graphJobs.get(execution.id); const job = jobId ? this.#jobs.get(jobId) : undefined;
      if (job) this.#cancel(job);
      else if (execution.status === "queued" || execution.status === "running") throw new WorkflowError("This run belongs to another local engine.");
      return { runId: execution.id, status: this.#definitions.getExecution(execution.id)?.status, cancellationRequested: Boolean(job) };
    }
    throw new WorkflowError("Unknown workflow lifecycle operation.", 400);
  }

  async handle(pathname: string, method: string, input: unknown, query: URLSearchParams): Promise<{ status: number; data: unknown } | null> {
    const learning = await this.learning.handle(pathname, method, input, query);
    if (learning) return learning;
    if (!pathname.startsWith(PREFIX + "workflows") && !pathname.startsWith(PREFIX + "workflow-definitions") && !pathname.startsWith(PREFIX + "workflow-executions") && pathname !== PREFIX + "workflow-tool-catalog" && !pathname.startsWith(PREFIX + "fixes/")) return null;
    this.#prune();
    try {
      if (pathname === PREFIX + "workflow-tool-catalog") {
        if (method !== "GET") throw new WorkflowError("Use GET to inspect workflow agent tools.", 405);
        return { status: 200, data: { tools: getToolsForRole("audit").map(({ name, description }) => ({ name, description })), policy: "agent-tools", pipelineChecks: true } };
      }
      if (pathname.startsWith(PREFIX + "workflow-definitions") || pathname.startsWith(PREFIX + "workflow-executions")) return await this.#definitionRequest(pathname, method, input, query);
      if (pathname === PREFIX + "workflows") {
        if (method === "GET") {
          const sessionId = parse(idSchema, query.get("sessionId"));
          return { status: 200, data: { workflows: [...this.#jobs.values()].filter(job => job.view.sessionId === sessionId).map(job => this.#project(job)) } };
        }
        if (method === "POST") return await this.#launch(input);
        return { status: 405, data: { error: "Use GET or POST for workflows." } };
      }
      const match = pathname.match(/^\/api\/console\/workflows\/([^/]+)(\/cancel)?$/);
      if (match) {
        const sessionId = match[2] ? parse(cancelSchema, input).sessionId : parse(idSchema, query.get("sessionId"));
        const job = this.#requireJob(decodeURIComponent(match[1]!), sessionId);
        if (!match[2] && method === "GET") {
          const after = Number(query.get("after") ?? "0");
          if (!Number.isSafeInteger(after) || after < 0) throw new WorkflowError("after must be a nonnegative integer.", 400);
          return { status: 200, data: { workflow: this.#project(job, after) } };
        }
        if (match[2] && method === "POST") {
          this.#cancel(job);
          return { status: 200, data: { workflow: this.#project(job) } };
        }
        return { status: 405, data: { error: match[2] ? "Use POST to cancel a workflow." : "Use GET to read a workflow." } };
      }
      if (pathname === PREFIX + "fixes/prepare") {
        if (method !== "POST") return { status: 405, data: { error: "Use POST to prepare a source fix." } };
        return await this.#prepare(input);
      }
      const fixRoute = pathname.match(/^\/api\/console\/fixes\/(propose|verify|apply|publish)$/);
      if (fixRoute) {
        if (method !== "POST") return { status: 405, data: { error: "Use POST for source-fix actions." } };
        return await this.#fixAction(fixRoute[1]!, input);
      }
      return null;
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof WorkflowError ? error.status
        : error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 409;
      return { status, data: { error: errorMessage(error) } };
    }
  }

  /** Session closure cancels its owned jobs, never another session's decisions or work. */
  cancelSession(sessionId: string): void {
    for (const job of this.#jobs.values()) if (job.view.sessionId === sessionId) this.#cancel(job);
  }

  async dispose(): Promise<void> {
    this.#disposing = true;
    for (const job of this.#jobs.values()) this.#cancel(job);
    await Promise.all([...this.#jobs.values()].map(job => job.promise));
    await Promise.all([...this.#workflowCandidates.values()].map(store => store.dispose()));
    await this.learning.dispose();
    this.#definitions.close();
  }

  async #definitionRequest(pathname: string, method: string, input: unknown, query: URLSearchParams): Promise<{ status: number; data: unknown }> {
    const definitionsPath = PREFIX + "workflow-definitions";
    const executionsPath = PREFIX + "workflow-executions";
    if (pathname === definitionsPath) {
      if (method === "GET") return { status: 200, data: { definitions: this.#definitions.list() } };
      if (method === "POST") return { status: 201, data: { definition: this.#definitions.save(parseSecurityWorkflowInput(input)) } };
      throw new WorkflowError("Use GET or POST for workflow definitions.", 405);
    }
    if (pathname === executionsPath && method === "GET") return { status: 200, data: { executions: this.#definitions.listExecutions(query.get("workflowId") ?? undefined, query.get("sessionId") ?? undefined) } };
    const definitionRoute = pathname.match(/^\/api\/console\/workflow-definitions\/([^/]+)(?:\/(run|executions|versions|rollback))?$/);
    if (definitionRoute) {
      const id = parse(idSchema, decodeURIComponent(definitionRoute[1]!));
      if (definitionRoute[2] === "versions" && method === "GET") return { status: 200, data: { versions: this.#definitions.listVersions(id) } };
      if (definitionRoute[2] === "rollback" && method === "POST") {
        const request = parse(z.object({ revision: z.number().int().positive(), expectedRevision: z.number().int().positive() }).strict(), input);
        return { status: 200, data: { definition: this.#definitions.rollback(id, request.revision, request.expectedRevision) } };
      }
      if (definitionRoute[2] === "run" && method === "POST") return this.#runDefinition(id, input);
      if (definitionRoute[2] === "executions" && method === "GET") return { status: 200, data: { executions: this.#definitions.listExecutions(id, query.get("sessionId") ?? undefined) } };
      if (!definitionRoute[2]) {
        if (method === "GET") {
          const definition = this.#definitions.get(id);
          if (!definition) throw new WorkflowError("Workflow definition was not found.", 404);
          return { status: 200, data: { definition } };
        }
        if (method === "PATCH") {
          const value = parseSecurityWorkflowInput(input);
          if (value.id !== undefined && value.id !== id) throw new WorkflowError("Workflow ID does not match the request path.", 400);
          if (value.revision === undefined) throw new WorkflowError("Editing requires the reviewed workflow revision.", 409);
          return { status: 200, data: { definition: this.#definitions.save({ ...value, id }) } };
        }
        if (method === "DELETE") {
          if (!query.has("revision")) throw new WorkflowError("Deleting requires the reviewed workflow revision.", 409);
          const revision = parse(z.number().int().positive(), Number(query.get("revision")));
          this.#definitions.delete(id, revision);
          return { status: 200, data: { ok: true } };
        }
      }
      throw new WorkflowError("Unsupported workflow definition action.", 405);
    }
    const executionRoute = pathname.match(/^\/api\/console\/workflow-executions\/([^/]+)(\/(?:cancel|results))?$/);
    if (executionRoute) {
      const id = parse(idSchema, decodeURIComponent(executionRoute[1]!));
      const sessionId = executionRoute[2] === "/cancel" ? parse(cancelSchema, input).sessionId : parse(idSchema, query.get("sessionId"));
      const execution = this.#definitions.getExecution(id);
      if (!execution || execution.sessionId !== sessionId) throw new WorkflowError("Workflow execution was not found for this session.", 404);
      if (executionRoute[2] === "/results" && method === "GET") return { status: 200, data: { results: this.#definitions.getExecutionResults(id) } };
      if (executionRoute[2] === "/cancel" && method === "POST") {
        const jobId = this.#graphJobs.get(id);
        const job = jobId ? this.#jobs.get(jobId) : undefined;
        if (!job && (execution.status === "queued" || execution.status === "running")) throw new WorkflowError("This execution belongs to another local engine. Cancel it in that engine.");
        if (job) this.#cancel(job);
        return { status: 200, data: { execution: this.#definitions.getExecution(id) } };
      }
      if (!executionRoute[2] && method === "GET") return { status: 200, data: { execution } };
      throw new WorkflowError("Unsupported workflow execution action.", 405);
    }
    throw new WorkflowError("Workflow route was not found.", 404);
  }

  /** Scheduler-only adapter: no client payload can opt out of target authorization. */
  async launchScheduledWorkflow(id: string, request: { sessionId: string; revision: number }): Promise<{ workflow: WebWorkflow; execution: SecurityWorkflowExecution }> {
    await this.validateScheduledWorkflow(id, request);
    const result = await this.#runDefinition(id, { ...request, approval: "launch-authorized-run" }, false);
    return result.data as { workflow: WebWorkflow; execution: SecurityWorkflowExecution };
  }

  async validateScheduledWorkflow(id: string, request: { sessionId: string; revision: number }): Promise<WebWorkflowExecutionContext> {
    if (this.#disposing) throw new WorkflowError("Workflow service is shutting down.", 503);
    const definition = this.#definitions.get(id);
    if (!definition) throw new WorkflowError("Workflow definition was not found.", 404);
    if (definition.revision !== request.revision) throw new WorkflowError("Workflow changed after review; refresh it before running.", 409);
    const audits = definition.nodes.filter(node => node.enabled && isSecurityWorkflowOperation(node));
    if (!audits.length) throw new WorkflowError("Enable at least one operation step before scheduling.", 400);
    if (!definition.target.trim()) throw new WorkflowError("Choose a target before scheduling this workflow.", 400);
    const resolved = resolveEngagement(definition.target);
    if (!resolved.ok) throw new WorkflowError(resolved.message, 400);
    this.#validateTemplateTarget(definition, resolved.plan.targetType);
    // Reject a background launch before creating an execution when a fresh
    // approval is needed. Each audit checks it again immediately before work.
    const context = await this.#gateway.authorizeWorkflowTarget(request.sessionId, { target: resolved.plan.kind === "package" ? definition.target : resolved.plan.target, kind: resolved.plan.kind }, undefined, undefined, { interactive: false });
    if (context.autonomyMode === "recon") throw new WorkflowError("Recon mode cannot authorize scheduled workflow operations.", 403);
    for (const node of audits) if (node.execution) withWorkflowAuditExecutionPolicy(node.execution, () => assertWorkflowNativeRuntime(context.runtime));
    return context;
  }

  #validateTemplateTarget(definition: SecurityWorkflow, targetType: string): void {
    if (!definition.template) return;
    try { checkSecurityWorkflowTemplateTarget(getSecurityWorkflowTemplate(definition.template.id, definition.template.revision), targetType); }
    catch (error) { throw new WorkflowError(errorMessage(error), 400); }
  }

  async #runDefinition(id: string, input: unknown, interactive = true, override?: SecurityWorkflow, options: { inputs?: Record<string, unknown>; allowApply?: boolean; timeCapMs?: number; costCapUsd?: number } = {}): Promise<{ status: number; data: unknown }> {
    if (this.#disposing) throw new WorkflowError("Workflow service is shutting down.", 503);
    const request = parse(definitionRunSchema, input);
    const definition = override ?? this.#definitions.get(id);
    if (!definition) throw new WorkflowError("Workflow definition was not found.", 404);
    if (definition.revision !== request.revision) throw new WorkflowError("Workflow changed after review; refresh it before running.", 409);
    if (!definition.target.trim()) throw new WorkflowError("Choose a target before running this workflow.", 400);
    const target = resolveEngagement(definition.target);
    if (!target.ok) throw new WorkflowError(target.message, 400);
    this.#validateTemplateTarget(definition, target.plan.targetType);
    const ordered = orderWorkflowNodes(definition);
    const auditNodes = ordered.filter(node => node.enabled && isSecurityWorkflowOperation(node));
    if (!auditNodes.length) throw new WorkflowError("Enable at least one operation step before running.", 400);
    const limits = auditNodes.reduce((total, node) => {
      const plan = node.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN;
      validateScanPlan(plan);
      return { timeCapMs: total.timeCapMs + plan.timeCapMs, costCapUsd: total.costCapUsd + plan.costCapUsd };
    }, { timeCapMs: 0, costCapUsd: 0 });
    if (!Number.isFinite(limits.timeCapMs) || !Number.isFinite(limits.costCapUsd)) throw new WorkflowError("Workflow limits must be finite.", 400);
    const context = await this.#gateway.getExecutionContext(request.sessionId);
    if (this.#disposing) throw new WorkflowError("Workflow service is shutting down.", 503);
    if (context.autonomyMode === "recon") throw new WorkflowError("Recon mode is read-only; switch modes before approving workflow operations.", 403);
    const inputs = options.inputs ?? {};
    const typed = auditNodes.filter(node => node.type !== "audit");
    let registry: WorkflowExecutorRegistry = {};
    if (typed.length) {
      if (target.plan.kind !== "source" || /^[a-z][a-z0-9+.-]*:\/\//i.test(target.plan.target) || target.plan.target.startsWith("git@")) throw new WorkflowError("Typed workflow operations require an authorized local source workspace.", 400);
      const authorized = await this.#gateway.authorizeWorkflowTarget(request.sessionId, { target: target.plan.target, kind: target.plan.kind }, undefined, undefined, { interactive });
      if (authorized.autonomyMode === "recon") throw new WorkflowError("Recon mode cannot authorize workflow operations.", 403);
      if (identity(selection(authorized)) !== identity(selection(context))) throw new WorkflowError("Session model or routing changed while authorizing workflow inputs.");
      if (authorized.runtime instanceof LlmApiRuntime && context.runtime instanceof LlmApiRuntime && authorized.runtime.connectionIdentity() !== context.runtime.connectionIdentity()) throw new WorkflowError("Session connection changed while authorizing workflow inputs.");
      const workspace = await realpath(target.plan.target);
      if (authorized.scopeEnforcement.enabled && (!authorized.localScopePath || !contained(await realpath(authorized.localScopePath), workspace))) throw new WorkflowError("Workflow inputs are outside the approved local scope.", 403);
      const typedDefinition = { ...definition, target: workspace };
      let candidateStore = this.#workflowCandidates.get(request.sessionId);
      if (!candidateStore) { candidateStore = createFindingCandidateStore(); this.#workflowCandidates.set(request.sessionId, candidateStore); }
      const findingOptions = { runtime: context.runtime, workspace, dbPath: context.dbPath ?? this.#dbPath, allowApply: options.allowApply === true, candidateStore };
      await validateFindingWorkflowInputs(typedDefinition, inputs, findingOptions);
      for (const node of typed) if (node.type === "research" || node.type === "deep-review") await validateResearchWorkflowInputs(node.type, { ...inputs, ...node.inputs, ...node.input }, { workspace, target: workspace });
      registry = { ...createFindingWorkflowExecutors(findingOptions), ...createResearchWorkflowExecutors({ runtime: context.runtime, workspace, dbPath: context.dbPath ?? this.#dbPath, model: context.model }) };
    }
    const parent = this.#createJob("workflow", request.sessionId, { workflowId: id, revision: request.revision, definition, limits }, context);
    let execution: SecurityWorkflowExecution;
    try { execution = override ? this.#definitions.createExecutionFromSnapshot((() => { const { createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = override; return draft; })(), request.sessionId) : this.#definitions.createExecution(id, request.sessionId, request.revision); }
    catch (error) { this.#jobs.delete(parent.view.id); throw error; }
    parent.view.executionId = execution.id;
    this.#graphJobs.set(execution.id, parent.view.id);
    this.#graphConnections.set(parent.view.id, context.runtime instanceof LlmApiRuntime ? (context.runtime.connectionIdentity() ?? null) : null);
    const nodeResults = Object.create(null) as SecurityWorkflowExecution["nodeResults"];
    for (const node of ordered) nodeResults[node.id] = { status: node.enabled ? "queued" : "skipped" };
    this.#definitions.updateExecution(execution.id, { jobId: parent.view.id, nodeResults });
    this.#start(parent, async () => {
      this.#definitions.updateExecution(execution.id, { status: "running" });
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...workflowInput } = definition;
      const result = await executeWorkflow({
        workflow: workflowInput,
        signal: parent.controller.signal,
        target: typed.length ? target.plan.target : definition.target,
        inputs,
        timeCapMs: options.timeCapMs ?? limits.timeCapMs,
        costCapUsd: options.costCapUsd ?? limits.costCapUsd,
        executors: Object.fromEntries(Object.entries(registry).map(([operation, executor]) => [operation, async (step: WorkflowAssessmentContext) => {
          const authorized = await this.#gateway.authorizeWorkflowTarget(request.sessionId, { target: target.plan.target, kind: target.plan.kind }, step.signal, parent.view.id, { interactive });
          if (authorized.autonomyMode === "recon") throw new WorkflowError("Recon mode cannot authorize workflow operations.", 403);
          if (identity(selection(authorized)) !== identity(parent.view.runtime)) throw new WorkflowError("Session model or routing changed during workflow authorization.");
          if (authorized.runtime instanceof LlmApiRuntime && (authorized.runtime.connectionIdentity() ?? null) !== this.#graphConnections.get(parent.view.id)) throw new WorkflowError("Session connection changed during workflow authorization.");
          const canonical = await realpath(target.plan.target);
          if (authorized.scopeEnforcement.enabled && (!authorized.localScopePath || !contained(await realpath(authorized.localScopePath), canonical))) throw new WorkflowError("Workflow operation is outside the approved local scope.", 403);
          return withScopeEnforcement(authorized.scopeEnforcement, () => executor!(step));
        }])) as WorkflowExecutorRegistry,
        onEvent: event => {
          if (event.nodeId && event.result) {
            const { reports: _reports, outputs: _outputs, ...links } = event.result;
            nodeResults[event.nodeId] = { ...nodeResults[event.nodeId], ...snapshot(links) };
            this.#definitions.updateExecution(execution.id, { nodeResults });
          }
          this.#event(parent, event.type === "report" ? "report" : "progress", event);
        },
        executeAssessment: async assessment => {
          const node = assessment.node;
          const retainLinks = (child: WebWorkflow) => {
            const dbPath = context.dbPath ?? this.#dbPath;
            nodeResults[node.id] = { status: child.status, jobId: child.id, scanIds: child.runs?.map(run => run.scanId), ...(dbPath ? { dbPaths: [dbPath] } : {}), ...(child.error ? { error: child.error } : {}) };
            this.#definitions.updateExecution(execution.id, { nodeResults });
          };
          let assessmentReport: ScanReport | undefined;
          const launched = await this.#launch({ sessionId: request.sessionId, target: assessment.target, plan: node.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN, approval: "launch-authorized-run" }, parent.view.id, retainLinks, node.execution, interactive, assessment, report => { assessmentReport = report; });
          const childView = (launched.data as { workflow: WebWorkflow }).workflow;
          const child = this.#jobs.get(childView.id)!;
          nodeResults[node.id] = { status: "running", jobId: child.view.id };
          this.#definitions.updateExecution(execution.id, { nodeResults });
          const cancelChild = () => this.#cancel(child);
          assessment.signal.addEventListener("abort", cancelChild, { once: true });
          if (assessment.signal.aborted) cancelChild();
          try { await child.promise; }
          finally { assessment.signal.removeEventListener("abort", cancelChild); }
          const dbPath = context.dbPath ?? this.#dbPath;
          return {
            status: child.view.status === "completed" ? "completed" as const : child.view.status === "cancelled" ? "cancelled" as const : "failed" as const,
            jobId: child.view.id,
            reports: assessmentReport ? [assessmentReport] : [],
            scanIds: child.view.runs?.map(run => run.scanId),
            ...(dbPath ? { dbPaths: [dbPath] } : {}),
            ...(child.view.error ? { error: child.view.error } : {}),
          };
        },
      });
      try { this.#definitions.saveExecutionResults(execution.id, result); }
      catch (error) { this.#event(parent, "report", { resultsPersisted: false, reason: errorMessage(error) }); }
      for (const [nodeId, step] of Object.entries(result.nodeResults)) {
        const { reports: _reports, outputs: _outputs, ...links } = step;
        nodeResults[nodeId] = { ...nodeResults[nodeId], ...links };
      }
      if (result.report) this.#retainReport(parent, result.report);
      if (result.status !== "completed") {
        if (result.status === "cancelled") parent.controller.abort(new Error(result.error ?? "Workflow cancelled."));
        throw new WorkflowError(result.error ?? `Workflow ${result.status}.`);
      }
    }, () => {
      const status = parent.view.status === "completed" ? "completed" : parent.view.status === "cancelled" ? "cancelled" : "failed";
      for (const result of Object.values(nodeResults)) if (result.status === "queued") result.status = status === "cancelled" ? "cancelled" : "blocked";
      for (const result of Object.values(nodeResults)) if (result.status === "running") result.status = status;
      this.#definitions.updateExecution(execution.id, { status, nodeResults, ...(parent.view.error ? { error: parent.view.error } : {}) });
      if (status === "completed" && target.plan.kind === "source" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target.plan.target) && !target.plan.target.startsWith("git@")) {
        try { this.learning.retainSourceContext(target.plan.target); }
        catch { this.#event(parent, "report", { learningRetained: false }); }
      }
      this.#graphConnections.delete(parent.view.id);
      this.#graphJobs.delete(execution.id);
    });
    return { status: 202, data: { workflow: this.#project(parent), execution: this.#definitions.getExecution(execution.id) } };
  }

  async #launch(input: unknown, owningGraphId?: string, retainLinks?: (job: WebWorkflow) => void, execution?: SecurityWorkflowNode["execution"], interactive = true, assessment?: WorkflowAssessmentContext, onAssessmentReport?: (report: ScanReport) => void): Promise<{ status: number; data: unknown }> {
    if (this.#disposing) throw new WorkflowError("Workflow service is shutting down.", 503);
    const graphSignal = owningGraphId ? this.#jobs.get(owningGraphId)?.controller.signal : undefined;
    graphSignal?.throwIfAborted();
    const request = parse(launchSchema, input);
    const executionPlan = assessment?.plan ?? request.plan;
    validateScanPlan(executionPlan);
    const resolution = resolveEngagement(request.target);
    if (!resolution.ok) throw new WorkflowError(resolution.message, 400);
    const context = await this.#gateway.getExecutionContext(request.sessionId);
    if (this.#disposing) throw new WorkflowError("Workflow service is shutting down.", 503);
    graphSignal?.throwIfAborted();
    if (execution) withWorkflowAuditExecutionPolicy(execution, () => assertWorkflowNativeRuntime(context.runtime));
    if (owningGraphId && identity(selection(context)) !== identity(this.#jobs.get(owningGraphId)!.view.runtime)) throw new WorkflowError("Session model or routing changed during this workflow. Review the selection and run it again.");
    if (owningGraphId && context.runtime instanceof LlmApiRuntime && (context.runtime.connectionIdentity() ?? null) !== this.#graphConnections.get(owningGraphId)) throw new WorkflowError("Session connection changed during this workflow. Review it and run again.");
    if (context.autonomyMode === "recon") throw new WorkflowError("Recon mode is read-only; switch modes before approving an effectful bounded scan.", 403);
    const resolved = snapshot(resolution.plan);
    const job = this.#createJob("run", request.sessionId, { ...request, resolved }, context, owningGraphId);
    const cancelFromGraph = () => this.#cancel(job);
    graphSignal?.addEventListener("abort", cancelFromGraph, { once: true });
    this.#start(job, async () => {
      const authorized = await this.#gateway.authorizeWorkflowTarget(request.sessionId, {
        target: resolved.kind === "package" ? request.target : resolved.target, kind: resolved.kind,
      }, job.controller.signal, job.view.id, { interactive });
      if (owningGraphId && identity(selection(authorized)) !== identity(this.#jobs.get(owningGraphId)!.view.runtime)) throw new WorkflowError("Session model or routing changed during workflow authorization. Review it and run again.");
      if (owningGraphId && authorized.runtime instanceof LlmApiRuntime && (authorized.runtime.connectionIdentity() ?? null) !== this.#graphConnections.get(owningGraphId)) throw new WorkflowError("Session connection changed during workflow authorization. Review it and run again.");
      if (authorized.autonomyMode === "recon") throw new WorkflowError("Recon mode cannot authorize an effectful bounded scan.", 403);
      if (resolved.kind === "source" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(resolved.target) && !resolved.target.startsWith("git@")) {
        const path = await realpath(resolved.target);
        if (authorized.scopeEnforcement.enabled && (!authorized.localScopePath || !contained(await realpath(authorized.localScopePath), path))) {
          throw new WorkflowError("Source run is outside the explicitly approved local scope.", 403);
        }
      }
      job.controller.signal.throwIfAborted();
      await withWorkflowAuditExecutionPolicy(execution, () => withScopeEnforcement(authorized.scopeEnforcement, () => runUnified({
        target: resolved.target,
        targetType: resolved.targetType,
        reviewPackageEcosystem: resolved.ecosystem,
        depth: executionPlan.depth,
        format: "json",
        runtime: "api",
        plan: snapshot(executionPlan),
        nativeRuntime: workflowPolicyRuntime(context.runtime),
        model: context.model,
        agentModels: context.agentModels,
        singleModel: context.singleModel,
        autoRoute: context.autoRoute,
        scope: authorized.scope,
        timeout: executionPlan.timeCapMs,
        costCeilingUsd: executionPlan.costCapUsd,
        dbPath: context.dbPath ?? this.#dbPath,
        signal: job.controller.signal,
        costLedger: assessment?.costLedger,
        priorFindings: assessment?.priorFindings,
        verbose: false,
        suppressOutput: true,
        suppressUi: true,
        embedded: true,
        onEvent: event => {
          if (event && typeof event === "object" && "data" in event && event.data && typeof event.data === "object" &&
              "scanId" in event.data && typeof event.data.scanId === "string" && "persisted" in event.data && event.data.persisted === true) {
            const scanId = event.data.scanId;
            const runs = job.view.runs ??= [];
            if (!runs.some(run => run.scanId === scanId)) {
              runs.push({ scanId,
                ...("runIndex" in event && typeof event.runIndex === "number" ? { runIndex: event.runIndex } : {}) });
              retainLinks?.(job.view);
            }
          }
          this.#event(job, "progress", event);
        },
        onReport: report => {
          // The runner receives complete evidence even when the browser memory
          // projection cannot retain a large report. Its bounded view is separate.
          onAssessmentReport?.(report);
          this.#retainReport(job, report);
        },
        onOutcome: outcome => {
          const { report: _report, ...details } = outcome;
          job.view.outcome = snapshot(details);
        },
      })));
      if (!job.view.outcome) throw new WorkflowError("Runner returned without an execution outcome.");
      const attempts = job.view.outcome.attempts;
      if (!attempts || attempts.length !== request.plan.runCount) throw new WorkflowError("Runner did not return every planned attempt outcome.");
      this.#event(job, "report", { outcome: job.view.outcome, reportRetained: job.view.reportRetained });
      if (attempts.some(attempt => attempt.status !== "completed")) {
        throw new WorkflowError(job.view.outcome.error ?? `Run plan stopped: ${job.view.outcome.exit_reason}.`);
      }
    }, () => graphSignal?.removeEventListener("abort", cancelFromGraph));
    return { status: 202, data: { workflow: this.#project(job) } };
  }

  async #prepare(input: unknown): Promise<{ status: number; data: unknown }> {
    const request = parse(prepareSchema, input);
    const context = await this.#gateway.getExecutionContext(request.sessionId);
    const focus = loadFindingFocus(request.findingId, { dbPath: context.dbPath ?? this.#dbPath });
    if (Buffer.byteLength(JSON.stringify(focus.finding)) > 2 * 1024 * 1024) throw new WorkflowError("Stored finding exceeds the browser review limit; no evidence was truncated or approved.", 413);
    const repoRoot = await resolveSourceFixRepository(request.repoRoot ?? context.localScopePath ?? focus.target);
    if (!repoRoot) throw new WorkflowError("Choose a local Git worktree root for this finding.", 400);
    const state = await repositoryState(repoRoot);
    if (state.dirty) throw new WorkflowError("Source-fix preparation requires a clean repository; existing user changes were preserved.");
    const saved = request.testCommand ? undefined : loadSourceFixProjectInputs(repoRoot);
    const testCommand = request.testCommand ?? saved?.testCommand ?? "";
    const eligibility = fixEligibility(focus.finding);
    const reason = eligibility.eligible ? (!testCommand ? "Review and enter a regression command before generation." : undefined) : eligibility.reason;
    const now = new Date().toISOString();
    const id = randomUUID();
    const view: WebFix = {
      id, sessionId: request.sessionId, createdAt: now, updatedAt: now,
      finding: snapshot(focus.finding), repoRoot, baseCommit: state.head, testCommand,
      reviewToken: identity({ id, finding: focus.finding, repoRoot, head: state.head, testCommand, runtime: selection(context) }),
      eligible: eligibility.eligible && Boolean(testCommand), ...(reason ? { reason } : {}), applied: false,
    };
    if (this.#fixes.size >= MAX_FIXES) {
      const oldest = [...this.#fixes.values()].find(fix => !fix.view.activeWorkflowId);
      if (!oldest) throw new WorkflowError("Source-fix review retention is full; finish or cancel an active operation.", 429);
      this.#fixes.delete(oldest.view.id);
    }
    this.#fixes.set(id, { view, dbPath: focus.dbPath, findingIdentity: identity(focus.finding), context });
    return { status: 200, data: { fix: snapshot(view) } };
  }

  async #fixAction(action: string, input: unknown): Promise<{ status: number; data: unknown }> {
    const request = parse(fixActionSchema, input);
    const fix = this.#fixes.get(request.fixId);
    if (!fix || fix.view.sessionId !== request.sessionId) throw new WorkflowError("Source-fix review was not found for this session.", 404);
    if (fix.view.activeWorkflowId) throw new WorkflowError("This source-fix review already has an active operation.");
    if (fix.view.published) throw new WorkflowError("This source-fix candidate was already published.");
    const currentContext = await this.#gateway.getExecutionContext(request.sessionId);
    if (currentContext.autonomyMode === "recon" && !(action === "publish" && request.approval === undefined)) {
      throw new WorkflowError("Recon mode is read-only; source-fix command execution, application and publication are blocked.", 403);
    }
    await this.#assertFixCurrent(fix);
    const view = fix.view;
    if (action === "propose") {
      if (request.approval !== "generate-and-test" || request.reviewToken !== view.reviewToken) throw new WorkflowError("Explicit approval of this exact repository, finding and regression command is required.", 403);
      if (!view.eligible) throw new WorkflowError(view.reason ?? "Source-fix inputs are not eligible.");
      if (fix.candidate || view.result) throw new WorkflowError("Prepare a new review to generate another candidate.");
    } else {
      if (!fix.candidate || !view.candidateId || request.candidateId !== view.candidateId) throw new WorkflowError("A displayed, exact verified candidate identity is required.", 403);
      if (view.applied) throw new WorkflowError("This candidate was already applied; the original checkout is preserved. Prepare a new review for further changes.");
      if (action !== "verify" && view.verification && view.verification.status !== "validated_candidate") throw new WorkflowError("Candidate failed its latest verification; explicitly re-verify before applying or publishing.");
      if (action === "publish" && request.approval === undefined) {
        const plan = await planSourceFixPublication(fix.candidate);
        view.publication = { ...plan, publicationToken: identity({ candidateId: view.candidateId, plan }) };
        view.updatedAt = new Date().toISOString();
        return { status: 200, data: { fix: snapshot(view) } };
      }
      const approval = action === "verify" ? "run-regression" : action === "apply" ? "apply-to-repository" : "publish-draft-pr";
      if (request.approval !== approval) throw new WorkflowError(`Separate explicit ${approval} approval is required.`, 403);
      if (action === "publish" && (!view.publication || request.publicationToken !== view.publication.publicationToken)) {
        throw new WorkflowError("Inspect and explicitly approve the exact current publication plan before publishing.", 403);
      }
    }
    if (this.#repositoryJobs.has(view.repoRoot)) throw new WorkflowError("Another source-fix operation owns this repository; wait or cancel it.");
    const kind = `fix-${action}` as "fix-propose" | "fix-verify" | "fix-apply" | "fix-publish";
    const job = this.#createJob(kind, view.sessionId, {
      fixId: view.id, findingId: view.finding.id, repoRoot: view.repoRoot, baseCommit: view.baseCommit,
      testCommand: view.testCommand, candidateId: view.candidateId, publication: view.publication,
      approval: request.approval,
    }, fix.context);
    view.activeWorkflowId = job.view.id;
    this.#repositoryJobs.set(view.repoRoot, job.view.id);
    this.#start(job, async () => {
        const authorized = await this.#gateway.authorizeWorkflowTarget(view.sessionId, { target: view.repoRoot, kind: "source" }, job.controller.signal, job.view.id);
        if (authorized.autonomyMode === "recon") throw new WorkflowError("Recon mode cannot authorize source-fix effects.", 403);
        if (authorized.scopeEnforcement.enabled && (!authorized.localScopePath || !contained(await realpath(authorized.localScopePath), view.repoRoot))) {
          throw new WorkflowError("Source fix is outside the explicitly approved local scope.", 403);
        }
        await this.#assertFixCurrent(fix);
        job.controller.signal.throwIfAborted();
        if (action === "propose") {
          // Persistence remembers operator-owned inputs, never future execution approval.
          saveSourceFixProjectInputs({ repoRoot: view.repoRoot, testCommand: view.testCommand });
          const result = await runSourceFix({
            repoRoot: view.repoRoot, finding: snapshot(view.finding), runtime: fix.context.runtime,
            testCommand: view.testCommand, apply: false, keepWorktree: true,
            signal: job.controller.signal, onProgress: event => this.#event(job, "progress", event),
          });
          view.result = snapshot(result);
          if (result.status === "validated_candidate" && result.candidate && result.diff) {
            fix.candidate = result;
            view.candidateId = identity({ fixId: view.id, findingId: view.finding.id, candidate: result.candidate, sourceFile: result.sourceFile, diff: result.diff });
          }
          if (result.status !== "validated_candidate") throw new WorkflowError(result.error ?? `Source-fix result: ${result.status}.`);
        } else if (action === "verify") {
          this.#event(job, "progress", { stage: "revalidating-exact-candidate" });
          const verified = await verifySourceFixCandidate(fix.candidate!, { signal: job.controller.signal });
          view.verification = snapshot(verified);
          if (verified.status !== "validated_candidate") throw new WorkflowError(verified.error ?? "Candidate verification failed.");
        } else if (action === "apply") {
          this.#event(job, "progress", { stage: "revalidating-before-explicit-apply" });
          const applied = await applySourceFixCandidate(fix.candidate!, { approval: "apply-to-repository", signal: job.controller.signal });
          view.application = snapshot(applied);
          view.applied = applied.applied;
          if (applied.status !== "applied_and_retested") throw new WorkflowError(applied.error ?? "Candidate was not safely applied.");
        } else {
          this.#event(job, "progress", { stage: "revalidating-before-explicit-publication", publication: view.publication });
          view.published = await publishSourceFixDraftPR(fix.candidate!, { approval: "publish-draft-pr", signal: job.controller.signal });
        }
    }, () => {
      delete view.activeWorkflowId;
      view.updatedAt = new Date().toISOString();
      job.view.result = { fix: snapshot(view) };
      this.#repositoryJobs.delete(view.repoRoot);
    });
    return { status: 202, data: { workflow: this.#project(job), fix: snapshot(view) } };
  }

  async #assertFixCurrent(fix: ManagedFix): Promise<void> {
    const focus = loadFindingFocus(fix.view.finding.id, { dbPath: fix.dbPath });
    if (identity(focus.finding) !== fix.findingIdentity) throw new WorkflowError("Stored finding evidence changed after preparation; prepare a fresh review.");
    const state = await repositoryState(fix.view.repoRoot);
    if (state.dirty || state.head !== fix.view.baseCommit) throw new WorkflowError("Original repository changed after preparation; no user changes were overwritten.");
  }

  #createJob(kind: WebWorkflow["kind"], sessionId: string, request: unknown, context: WebWorkflowExecutionContext, owningGraphId?: string): ManagedJob {
    this.#prune();
    if ([...this.#jobs.values()].filter(active).length >= MAX_ACTIVE) throw new WorkflowError("Too many active browser workflows; wait or cancel one.", 429);
    if ([...this.#jobs.values()].some(job => active(job) && job.view.sessionId === sessionId && job.view.id !== owningGraphId)) throw new WorkflowError("This session already owns an active workflow; wait or cancel it.");
    if (this.#jobs.size >= MAX_JOBS) {
      const oldest = [...this.#jobs.values()].find(job => !active(job));
      if (!oldest) throw new WorkflowError("Browser workflow retention is full.", 429);
      this.#jobs.delete(oldest.view.id);
    }
    const now = new Date().toISOString();
    const job: ManagedJob = {
      view: { id: randomUUID(), sessionId, kind, status: "queued", createdAt: now, updatedAt: now,
        request: snapshot(request), runtime: selection(context), events: [], oldestSequence: 1, eventsTruncated: false, reportRetained: false },
      controller: new AbortController(), sequence: 0, reportBytes: 0,
    };
    this.#jobs.set(job.view.id, job);
    this.#event(job, "state", { status: "queued" });
    return job;
  }

  #start(job: ManagedJob, operation: () => Promise<void>, onSettled?: () => void): void {
    job.promise = Promise.resolve().then(async () => {
      job.controller.signal.throwIfAborted();
      job.view.status = "running";
      this.#event(job, "state", { status: "running" });
      await operation();
      // A completed irreversible action remains completed even if cancellation
      // arrived after its success. Never claim remote publication was undone.
      job.view.status = "completed";
    }).catch((error: unknown) => {
      job.view.status = job.controller.signal.aborted ? "cancelled" : "failed";
      job.view.error = errorMessage(error);
      this.#event(job, "error", { message: job.view.error });
    }).finally(() => {
      onSettled?.();
      job.settledAt = Date.now();
      this.#event(job, "state", { status: job.view.status });
    });
  }

  #cancel(job: ManagedJob): void {
    if (!active(job) || job.controller.signal.aborted) return;
    job.view.status = "cancelling";
    job.controller.abort(new Error("Operator cancelled this owned workflow."));
    this.#event(job, "state", { status: "cancelling", cancellationRequested: true });
  }

  #requireJob(id: string, sessionId: string): ManagedJob {
    const job = this.#jobs.get(id);
    if (!job || job.view.sessionId !== sessionId) throw new WorkflowError("Workflow was not found for this session.", 404);
    return job;
  }

  #project(job: ManagedJob, after = 0): WebWorkflow {
    const view = snapshot({ ...job.view, events: job.view.events.filter(event => event.sequence > after) });
    view.eventsTruncated = job.view.oldestSequence > after + 1;
    if (job.view.kind !== "run" && view.request && typeof view.request === "object" &&
        "fixId" in view.request && typeof view.request.fixId === "string") {
      const fix = this.#fixes.get(view.request.fixId);
      if (fix) view.result = { fix: snapshot(fix.view) };
    }
    return view;
  }

  #event(job: ManagedJob, type: WebWorkflowEvent["type"], data: unknown): void {
    const now = new Date().toISOString();
    const encoded = JSON.stringify(data);
    const safeData = encoded && Buffer.byteLength(encoded) > MAX_EVENT_BYTES
      ? { truncated: true, originalBytes: Buffer.byteLength(encoded), preview: encoded.slice(0, MAX_EVENT_BYTES / 2) }
      : snapshot(data);
    job.view.events.push({ sequence: ++job.sequence, timestamp: now, type, data: safeData });
    if (job.view.events.length > MAX_EVENTS) job.view.events.splice(0, job.view.events.length - MAX_EVENTS);
    job.view.oldestSequence = job.view.events[0]?.sequence ?? job.sequence + 1;
    job.view.updatedAt = now;
  }

  #retainReport(job: ManagedJob, report: ScanReport): void {
    const bytes = Buffer.byteLength(JSON.stringify(report));
    if (bytes > MAX_REPORT_BYTES) {
      job.view.reportRetentionReason = "Actual report exceeds browser memory retention; persisted scan findings and events remain available in run history.";
      this.#event(job, "report", { reportRetained: false, originalBytes: bytes, reason: job.view.reportRetentionReason });
      return;
    }
    let retained = [...this.#jobs.values()].reduce((sum, current) => sum + current.reportBytes, 0) - job.reportBytes;
    for (const older of this.#jobs.values()) {
      if (retained + bytes <= MAX_REPORT_BYTES) break;
      if (older === job || !older.reportBytes) continue;
      retained -= older.reportBytes;
      delete older.view.report;
      older.reportBytes = 0;
      older.view.reportRetained = false;
      older.view.reportRetentionReason = "Report left bounded browser retention; persisted run history remains available.";
    }
    job.view.report = snapshot(report);
    job.view.reportRetained = true;
    delete job.view.reportRetentionReason;
    job.reportBytes = bytes;
  }

  #prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, job] of this.#jobs) if (job.settledAt && job.settledAt < cutoff) this.#jobs.delete(id);
    for (const [id, fix] of this.#fixes) if (!fix.view.activeWorkflowId && Date.parse(fix.view.updatedAt) < cutoff) this.#fixes.delete(id);
  }
}
