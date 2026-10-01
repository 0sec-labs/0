import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { SecurityWorkflowStore } from "@0/db";
import {
  SECURITY_WORKFLOW_TEMPLATES, getSecurityWorkflowTemplate, checkSecurityWorkflowTemplateTarget,
  createSecurityWorkflowTemplate, parseSecurityWorkflowInput, SecurityWorkflowBindingsSchema,
  type SecurityWorkflowExecution, type SecurityWorkflowNodeResult,
} from "@0/shared";
import {
  WorkflowService, executeAssessment, LlmApiRuntime, loadScope, getScopeEnforcementState,
  withScopeEnforcement, workflowPolicyRuntime,
  type WorkflowServiceRun, type WorkflowRunResult, type AssessmentOptions, type NativeRuntime, type WorkflowExecutorRegistry,
} from "@0/core";
import { createFindingWorkflowExecutors, createFindingCandidateStore, validateFindingWorkflowInputs } from "./finding-workflow-executors.js";
import { createResearchWorkflowExecutors, validateResearchWorkflowInputs } from "./workflow-research-executors.js";
import { resolveEngagement } from "./engagement-plan.js";

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
/** Test seam; production always uses the configured native provider and assessment executor. */
export interface CliWorkflowDependencies {
  createRuntime(options: { model?: string; timeout: number }): NativeRuntime;
  assess(options: AssessmentOptions): ReturnType<typeof executeAssessment>;
}
const defaults: CliWorkflowDependencies = {
  createRuntime: options => new LlmApiRuntime({ type: "api", ...options }),
  assess: options => executeAssessment(options),
};
function bounded(value: number | undefined, fallback: number | undefined, maximum: number, name: string): number | undefined {
  const selected = value === undefined ? fallback : fallback === undefined ? value : Math.min(value, fallback);
  if (selected !== undefined && (!Number.isFinite(selected) || selected <= 0 || selected > maximum)) throw new Error(`${name} must be positive and at most ${maximum}.`);
  return selected;
}
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
function nodeLinks(run: WorkflowServiceRun): Record<string, SecurityWorkflowNodeResult> {
  const nodes: Record<string, SecurityWorkflowNodeResult> = Object.fromEntries(run.workflow.nodes.map(node => [node.id, { status: node.enabled ? run.status === "failed" ? "blocked" : run.status === "cancelled" ? "cancelled" : "queued" : "skipped" }]));
  for (const event of run.events) {
    if (event.type === "node_started") nodes[event.nodeId] = { status: "running" };
    if (event.result) {
      const { status, scanIds, dbPaths, error } = event.result;
      nodes[event.nodeId] = { status, ...(scanIds ? { scanIds } : {}), ...(dbPaths ? { dbPaths } : {}), ...(error ? { error } : {}) };
    }
  }
  if (run.result) for (const [id, result] of Object.entries(run.result.nodeResults)) {
    const { status, scanIds, dbPaths, error } = result;
    nodes[id] = { status, ...(scanIds ? { scanIds } : {}), ...(dbPaths ? { dbPaths } : {}), ...(error ? { error } : {}) };
  }
  return nodes;
}

/** Bindings are data, never portable approvals or executable graph code. */
export function parseWorkflowRunInputs(value: unknown): Record<string, unknown> {
  return structuredClone(SecurityWorkflowBindingsSchema.parse(value ?? {}));
}

/** CLI and stdio adapters share the core runner and retain their own execution ownership. */
export async function createCliWorkflowRuntime(options: CliWorkflowRuntimeOptions, dependencies: CliWorkflowDependencies = defaults) {
  if (!options.ownerId || options.ownerId.length > 128) throw new Error("A workflow runtime requires a valid owner.");
  if (options.workspace && !isAbsolute(options.workspace)) throw new Error("The authorized workspace must be an absolute path.");
  const workspace = options.workspace ? await realpath(options.workspace) : options.ownerId === "cli" ? await realpath(process.cwd()) : undefined;
  const scope = options.scopePath ? loadScope(options.scopePath) : undefined;
  const scopeState = getScopeEnforcementState(workspace);
  const store = new SecurityWorkflowStore(options.dbPath);
  if (options.recoverInterrupted !== false) store.interruptActiveExecutions();
  const candidateStore = createFindingCandidateStore();
  const owned = new Set<string>();
  const requests = new Map<string, { id: string; fingerprint: string }>();
  const launches = new Map<string, { signature: string; promise: Promise<SecurityWorkflowExecution> }>();
  let disposed = false;
  const service = new WorkflowService({ onChange: run => {
    let retentionError: string | undefined;
    if (run.result) {
      try { store.saveExecutionResults(run.id, run.result); }
      catch (error) { retentionError = `Workflow completed with results available in its owning host, but durable result retention failed: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const current = store.getExecution(run.id);
    if (current && ["queued", "running"].includes(current.status)) store.updateExecution(run.id, {
      status: run.status, nodeResults: nodeLinks(run), ...(run.error || retentionError ? { error: (run.error ?? retentionError)!.slice(0, 16_000) } : {}),
    });
  } });
  const read = (id: string, operatorInspection = false) => {
    const execution = store.getExecution(id);
    if (!execution || execution.sessionId !== options.ownerId && !(operatorInspection && options.ownerId === "cli")) throw new Error("Workflow run was not found for this owner.");
    return execution;
  };
  const preflight = async (target: string) => {
    if (options.target && target.trim() !== options.target.trim()) throw new Error("Target does not match this workflow server's configured target.");
    const resolution = resolveEngagement(target);
    if (!resolution.ok) throw new Error(resolution.message);
    const resolved = resolution.plan;
    if (resolved.kind === "source") {
      if (!workspace) throw new Error("Source workflows require an explicitly authorized --workspace.");
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resolved.target) || resolved.target.startsWith("git@")) {
        if (options.ownerId !== "cli" && (!options.target || options.target.trim() !== target.trim())) throw new Error("Remote source workflows require a fixed --target and an authorized --workspace.");
      } else if (!contains(workspace, await realpath(resolved.target))) throw new Error("Source target is outside the authorized workspace.");
    } else if (resolved.kind === "web") {
      if (!scope) throw new Error("Live workflow targets require --scope.");
      if (!scopeState.enabled) throw new Error("Live workflows require scope enforcement. Enable the scope plugin for this project with `0 plugin enable scope`.");
      const verdict = scope.match(resolved.target);
      if (!verdict.allowed) throw new Error(`Workflow target is out of scope: ${verdict.reason}`);
    }
    return resolved;
  };
  const start = async (request: StartWorkflowRun): Promise<SecurityWorkflowExecution> => {
    if (disposed) throw new Error("Workflow runtime is shutting down.");
    if (Boolean(request.templateId) === Boolean(request.workflowId)) throw new Error("Select exactly one template or saved workflow.");
    const target = request.target?.trim();
    if (!target) throw new Error("A workflow target is required.");
    const resolved = await preflight(target);
    if (disposed) throw new Error("Workflow runtime is shutting down.");
    const workflow = request.templateId
      ? createSecurityWorkflowTemplate(request.templateId, { revision: request.revision, target, targetType: resolved.targetType })
      : store.get(request.workflowId!);
    if (!workflow) throw new Error("Workflow was not found.");
    if (request.workflowId && request.revision !== undefined && workflow.revision !== request.revision) throw new Error("Workflow revision changed; refresh before running.");
    if (workflow.template) checkSecurityWorkflowTemplateTarget(getSecurityWorkflowTemplate(workflow.template.id, workflow.template.revision), resolved.targetType);
    if (!workflow.nodes.some(node => node.enabled && node.type !== "trigger" && node.type !== "report")) throw new Error("Enable at least one executable step before running.");
    if (request.allowApply && !options.allowApply) throw new Error("This host does not authorize applying fixes.");
    const inputs = parseWorkflowRunInputs(request.inputs);
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...portable } = workflow as typeof workflow & { createdAt?: string; updatedAt?: string };
    const definition = parseSecurityWorkflowInput({ ...portable, target });
    const timeCapMs = bounded(request.timeCapMs, options.timeCapMs, 86_400_000, "Time cap");
    const costCapUsd = bounded(request.costCapUsd, options.costCapUsd, 1000, "Cost cap");
    const fingerprint = createHash("sha256").update(JSON.stringify({ definition, inputs, allowApply: request.allowApply === true, model: request.model ?? options.model, timeCapMs, costCapUsd })).digest("hex");
    if (request.idempotencyKey) {
      const previous = requests.get(request.idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Idempotency key belongs to a different workflow request.");
        return read(previous.id);
      }
    }
    const specialized = definition.nodes.filter(node => node.enabled && !["trigger", "audit", "report"].includes(node.type));
    if (specialized.length && (!workspace || resolved.kind !== "source" || /^[a-z][a-z0-9+.-]*:\/\//i.test(resolved.target) || resolved.target.startsWith("git@"))) {
      throw new Error("Specialized workflows require a local source target inside the authorized workspace.");
    }
    for (const node of specialized) if (node.type === "research" || node.type === "deep-review") {
      await validateResearchWorkflowInputs(node.type, { ...inputs, ...node.inputs, ...node.input }, { workspace: workspace!, target: resolved.target });
    }
    const runtime = dependencies.createRuntime({ model: request.model ?? options.model, timeout: timeCapMs ?? 600_000 });
    const needsModel = definition.nodes.some(node => {
      if (!node.enabled) return false;
      if (node.type === "audit" || node.type === "deep-review") return true;
      if (node.type === "fix") return node.fix?.mode !== "apply";
      if (node.type === "research") {
        const bindings: Record<string, unknown> = { ...inputs, ...node.inputs, ...node.input };
        return bindings.engine === undefined || bindings.engine === "pipeline";
      }
      return false;
    });
    if (needsModel && !await runtime.isAvailable()) throw new Error("Configure 0's model provider before starting this workflow.");
    const findingOptions = { runtime, candidateStore, workspace: workspace ?? "", dbPath: options.dbPath, scopeFile: options.scopePath, allowApply: options.allowApply === true && request.allowApply === true };
    await validateFindingWorkflowInputs({ ...definition, target: resolved.target }, inputs, findingOptions);
    const executors: WorkflowExecutorRegistry = specialized.length ? { ...createFindingWorkflowExecutors(findingOptions), ...createResearchWorkflowExecutors({ runtime, workspace: workspace!, dbPath: options.dbPath, model: request.model ?? options.model }) } : {};
    for (const [operation, executor] of Object.entries(executors)) {
      executors[operation as keyof WorkflowExecutorRegistry] = context => withScopeEnforcement(scopeState, () => executor!(context));
    }
    if (disposed) throw new Error("Workflow runtime is shutting down.");
    const execution = store.createExecutionFromSnapshot({ ...definition, id: request.workflowId ?? `template-${request.templateId}`, revision: workflow.revision ?? 1 }, options.ownerId);
    owned.add(execution.id);
    if (request.idempotencyKey) requests.set(request.idempotencyKey, { id: execution.id, fingerprint });
    service.start(options.ownerId, {
      workflow: definition, target: resolved.target, timeCapMs, costCapUsd, inputs, executors,
      executeAssessment: async context => {
        const scanIds: string[] = [];
        const { report } = await withScopeEnforcement(scopeState, () => dependencies.assess({
          target: resolved.target, targetType: resolved.targetType, reviewPackageEcosystem: resolved.ecosystem,
          runtime: "api", depth: context.plan.depth, format: "json", timeout: context.plan.timeCapMs,
          plan: context.plan, costCeilingUsd: context.plan.costCapUsd, costLedger: context.costLedger,
          nativeRuntime: workflowPolicyRuntime(runtime), model: request.model ?? options.model,
          scope, scopeFile: options.scopePath, signal: context.signal, dbPath: options.dbPath,
          priorFindings: context.priorFindings,
          onEvent: event => {
            const data = (event as { data?: { scanId?: unknown; persisted?: unknown } })?.data;
            if (data?.persisted === true && typeof data.scanId === "string" && !scanIds.includes(data.scanId)) scanIds.push(data.scanId);
          },
        }));
        const failed = report.executionSuccessful === false || report.costCeilingExceeded || ["failed", "error", "partial", "time_cap_exceeded", "cancelled"].includes(report.exitReason ?? "");
        return { status: report.exitReason === "cancelled" ? "cancelled" : failed ? "failed" : "completed", reports: [report], scanIds, ...(options.dbPath ? { dbPaths: [options.dbPath] } : {}), ...(report.error ? { error: report.error } : {}) };
      },
    }, { id: execution.id });
    return execution;
  };
  const getRun = (id: string) => {
    const execution = read(id, true);
    if (!owned.has(id)) return execution;
    let view: WorkflowServiceRun;
    try { view = service.get(options.ownerId, id); }
    catch (error) { if (!["queued", "running"].includes(execution.status)) return execution; throw error; }
    return { ...execution, status: view.status, nodeResults: nodeLinks(view), error: view.error ?? execution.error,
      ...(view.cancellationRequestedAt ? { cancellationRequested: true, cancellationAcknowledged: true, cancellationRequestedAt: view.cancellationRequestedAt } : {}),
      events: view.events.map(event => ({ ...event, result: event.result ? { status: event.result.status, scanIds: event.result.scanIds, dbPaths: event.result.dbPaths, error: event.result.error } : undefined, findings: undefined })),
      oldestSequence: view.oldestSequence, eventsTruncated: view.eventsTruncated };
  };
  return {
    listTemplates: () => structuredClone(SECURITY_WORKFLOW_TEMPLATES),
    getTemplate: (id: string) => getSecurityWorkflowTemplate(id),
    listWorkflows: () => store.list(),
    listRuns: () => store.listExecutions(undefined, options.ownerId).map(execution => getRun(execution.id)),
    getWorkflow: (id: string) => store.get(id),
    saveWorkflow: (definition: unknown, expectedRevision?: number) => {
      const parsed = parseSecurityWorkflowInput(definition);
      return store.save({ ...parsed, ...(expectedRevision !== undefined ? { revision: expectedRevision } : {}) });
    },
    startRun: (request: StartWorkflowRun): Promise<SecurityWorkflowExecution> => {
      // Coalesce concurrent retries before provider validation or history allocation.
      if (!request.idempotencyKey) return start(request);
      const key = request.idempotencyKey;
      const signature = JSON.stringify(request);
      const active = launches.get(key);
      if (active) {
        if (active.signature !== signature) return Promise.reject(new Error("Idempotency key belongs to a different workflow request."));
        return active.promise;
      }
      const launch = start(request);
      launches.set(key, { signature, promise: launch });
      void launch.finally(() => launches.delete(key)).catch(() => {});
      return launch;
    },
    getRun,
    getRunResults: (id: string, page: { cursor?: number; limit?: number } = {}) => {
      const execution = read(id, true);
      const cursor = page.cursor ?? 0;
      const limit = page.limit ?? 100;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid result page; limit must be 1–100 and cursor nonnegative.");
      let liveResult: WorkflowRunResult | undefined;
      if (owned.has(id)) {
        try { liveResult = service.getResults(options.ownerId, id); }
        catch (error) { if (["queued", "running"].includes(execution.status)) throw error; }
      }
      const result = liveResult ?? store.getExecutionResults(id) as WorkflowRunResult | null;
      if (!result) return { runId: id, findings: [], reports: [], nextCursor: null, retained: false, pending: ["queued", "running"].includes(execution.status), error: execution.error };
      return { runId: id, status: result.status, retained: true, report: result.report ? { ...result.report, findings: result.findings.slice(cursor, cursor + limit) } : undefined, findings: result.findings.slice(cursor, cursor + limit),
        reports: result.reports.map(report => ({ ...report, findings: undefined })), outputs: result.outputs, nodeResults: nodeLinks({ result, workflow: result.workflow, events: [] } as unknown as WorkflowServiceRun),
        totalFindings: result.findings.length, nextCursor: cursor + limit < result.findings.length ? cursor + limit : null, costUsd: result.costUsd, durationMs: result.durationMs, error: result.error };
    },
    cancelRun: (id: string) => {
      const execution = read(id);
      if (!owned.has(id)) {
        if (["queued", "running"].includes(execution.status)) throw new Error("This run belongs to another host. Cancel it in its owning engine.");
        return execution;
      }
      try { service.cancel(options.ownerId, id); }
      catch (error) { if (["queued", "running"].includes(execution.status)) throw error; }
      return getRun(id);
    },
    dispose: async () => { if (disposed) return; disposed = true; await Promise.allSettled([...launches.values()].map(launch => launch.promise)); await service.dispose(); try { await candidateStore.dispose(); } finally { store.close(); } },
  };
}
