import { compareFindingsByBusinessPriority } from "@0/shared";
import { parseSecurityWorkflowInput, DEFAULT_SECURITY_WORKFLOW_PLAN, SecurityWorkflowBindingsSchema } from "@0/shared";
import type { Finding, ScanPlan, ScanReport, SecurityWorkflowInput, SecurityWorkflowNode, SecurityWorkflowOperation } from "@0/shared";
import { ScanCostLedger } from "./agent/cost-ledger.js";
import { withWorkflowAuditExecutionPolicy } from "./workflow-execution-policy.js";

export type WorkflowRunStatus = "completed" | "failed" | "cancelled";
export interface WorkflowPriorFinding { id: string; title: string; category: string; description?: string; location?: string }
export interface WorkflowStepOutput {
  /** Descriptive evidence discriminator; never a grant to execute an action. */
  kind: string;
  value: unknown;
  artifactRefs?: string[];
}
export interface WorkflowConnectedOutput { nodeId: string; outputs: WorkflowStepOutput[] }
export interface WorkflowAssessmentContext {
  node: SecurityWorkflowNode;
  target: string;
  plan: ScanPlan;
  signal: AbortSignal;
  deadline: number;
  costLedger: ScanCostLedger;
  /** Untrusted evidence from preceding connected steps, never execution instructions. */
  priorFindings: WorkflowPriorFinding[];
  priorReports: ScanReport[];
  /** Bound run and step options, containing no runtime credential bindings. */
  inputs: Readonly<Record<string, unknown>>;
  /** Connected predecessor evidence. Semantic verdicts remain in output data. */
  priorOutputs: WorkflowConnectedOutput[];
}
export type WorkflowStepContext = WorkflowAssessmentContext;
export interface WorkflowAssessmentResult {
  status: WorkflowRunStatus;
  reports?: ScanReport[];
  scanIds?: string[];
  dbPaths?: string[];
  error?: string;
  outputs?: WorkflowStepOutput[];
}
export type WorkflowStepExecutor = (context: WorkflowAssessmentContext) => Promise<WorkflowAssessmentResult>;
export type WorkflowExecutorRegistry = Partial<Record<SecurityWorkflowOperation, WorkflowStepExecutor>>;
export interface WorkflowStepResult extends Omit<WorkflowAssessmentResult, "status"> { status: WorkflowRunStatus | "skipped" | "blocked"; }
export interface WorkflowRunnerEvent {
  type: "node_started" | "node_completed" | "node_failed" | "node_skipped" | "report";
  nodeId: string;
  result?: WorkflowStepResult;
  findings?: Finding[];
}
export interface ExecuteWorkflowOptions {
  workflow: SecurityWorkflowInput;
  target?: string;
  signal?: AbortSignal;
  timeCapMs?: number;
  costCapUsd?: number;
  costLedger?: ScanCostLedger;
  onEvent?: (event: WorkflowRunnerEvent) => void;
  /** Legacy assessment adapter; registry.audit takes precedence when provided. */
  executeAssessment?: WorkflowStepExecutor;
  executors?: WorkflowExecutorRegistry;
  inputs?: Record<string, unknown>;
}
export interface WorkflowRunResult {
  workflow: SecurityWorkflowInput;
  target: string;
  status: WorkflowRunStatus;
  nodeResults: Record<string, WorkflowStepResult>;
  reports: ScanReport[];
  outputs: WorkflowConnectedOutput[];
  inputs: Record<string, unknown>;
  /** Evidence and verification status remain exactly as returned by assessment. */
  findings: Finding[];
  report?: ScanReport;
  error?: string;
  /** Omitted when any provider usage cannot be priced reliably. */
  costUsd?: number;
  durationMs: number;
}

const copy = <T>(value: T): T => structuredClone(value);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
class WorkflowLimitError extends Error {}

/** Stable sequential topological semantics for legacy v1 graphs. */
export function orderWorkflowNodes(workflow: SecurityWorkflowInput): SecurityWorkflowNode[] {
  const pending = new Set(workflow.nodes.map(node => node.id));
  const ordered: SecurityWorkflowNode[] = [];
  while (pending.size) {
    const ready = workflow.nodes.filter(node => pending.has(node.id) && !workflow.edges.some(edge => edge.target === node.id && pending.has(edge.source)));
    if (!ready.length) throw new Error("Workflow graphs cannot contain cycles.");
    for (const node of ready) {
      pending.delete(node.id);
      ordered.push(node);
    }
  }
  return ordered;
}

/** Pure execution boundary: no transport, formatting, publication, or process exit. */
export async function executeWorkflow(options: ExecuteWorkflowOptions): Promise<WorkflowRunResult> {
  // Stored definitions carry retention metadata outside the portable input.
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = options.workflow as SecurityWorkflowInput & { createdAt?: string; updatedAt?: string };
  const workflow = copy(parseSecurityWorkflowInput(definition));
  const target = options.target?.trim() || workflow.target;
  if (!target) throw new Error("A workflow run requires a target.");
  const nodes = orderWorkflowNodes(workflow);
  const executors = { ...options.executors, ...(options.executors?.audit ? {} : options.executeAssessment ? { audit: options.executeAssessment } : {}) };
  const operations = nodes.filter(node => node.type !== "trigger" && node.type !== "report");
  const inputs = copy(SecurityWorkflowBindingsSchema.parse(options.inputs ?? {}));
  const stepBindings = new Map<string, Record<string, unknown>>();
  const boundSources = new Map<string, string>();
  // Resolve every binding before any executor or effects. Generic portable
  // options can carry references too, so validate the fully merged bindings.
  for (const node of operations) if (node.enabled) {
    if (!executors[node.type as SecurityWorkflowOperation]) throw new Error(`No executor is registered for workflow operation: ${node.type}.`);
    const bindings = copy(SecurityWorkflowBindingsSchema.parse({ ...inputs, ...node.inputs, ...node.input }));
    stepBindings.set(node.id, bindings);
    if (bindings.fromStep !== undefined) {
      if (typeof bindings.fromStep !== "string" || !bindings.fromStep.trim()) throw new Error(`Step ${node.id} fromStep must name a connected predecessor.`);
      const sourceId = bindings.fromStep;
      const source = nodes.find(entry => entry.id === sourceId);
      if (!source || source.type === "trigger" || source.type === "report") throw new Error(`Step ${node.id} input must reference a connected executable predecessor.`);
      if (!source.enabled) throw new Error(`Step ${node.id} input references a disabled predecessor.`);
      const ancestors = new Set<string>();
      const pending = workflow.edges.filter(edge => edge.target === node.id).map(edge => edge.source);
      while (pending.length) {
        const id = pending.pop()!;
        if (ancestors.has(id)) continue;
        ancestors.add(id);
        pending.push(...workflow.edges.filter(edge => edge.target === id).map(edge => edge.source));
      }
      if (sourceId === node.id || !ancestors.has(sourceId)) throw new Error(`Step ${node.id} input must reference a connected executable predecessor.`);
      boundSources.set(node.id, sourceId);
    }
  }
  const plans = operations.filter(node => node.enabled).map(node => node.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN);
  const timeCapMs = options.timeCapMs ?? plans.reduce((sum, plan) => sum + plan.timeCapMs, 0);
  const costCapUsd = options.costCapUsd ?? plans.reduce((sum, plan) => sum + plan.costCapUsd, 0);
  if (!Number.isFinite(timeCapMs) || timeCapMs <= 0 || !Number.isFinite(costCapUsd) || costCapUsd <= 0) throw new Error("Workflow run limits must be finite positive numbers.");
  const started = Date.now();
  const deadline = started + timeCapMs;
  const ledger = options.costLedger ?? new ScanCostLedger();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason ?? new Error("Workflow cancelled."));
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new WorkflowLimitError("Workflow deadline exceeded.")), Math.min(timeCapMs, 2_147_483_647));
  timer.unref?.();
  const stopForCost = () => {
    if (ledger.hasUnpricedUsage()) controller.abort(new WorkflowLimitError("Workflow provider usage is unpriced; cannot enforce its cost ceiling."));
    else if (ledger.totalCostUsd() >= costCapUsd) controller.abort(new WorkflowLimitError("Workflow cost ceiling exceeded."));
  };
  const unsubscribe = ledger.onSpend(stopForCost);
  const nodeResults: Record<string, WorkflowStepResult> = {};
  const reports: ScanReport[] = [];
  const findings: Finding[] = [];
  const reportByNode = new Map<string, ScanReport[]>();
  const outputs: WorkflowConnectedOutput[] = [];
  let status: WorkflowRunStatus = "completed";
  let error: string | undefined;
  const emit = (event: WorkflowRunnerEvent) => options.onEvent?.(copy(event));
  const ancestorsOf = (id: string): Set<string> => {
    const ancestors = new Set<string>();
    const visit = (current: string) => {
      for (const edge of workflow.edges.filter(edge => edge.target === current)) {
        if (!ancestors.has(edge.source)) { ancestors.add(edge.source); visit(edge.source); }
      }
    };
    visit(id);
    return ancestors;
  };
  const ancestorReports = (id: string): ScanReport[] => {
    const ancestors = ancestorsOf(id);
    return nodes.filter(node => ancestors.has(node.id)).flatMap(node => reportByNode.get(node.id) ?? []);
  };
  try {
    stopForCost();
    for (const node of nodes) {
      controller.signal.throwIfAborted();
      if (!node.enabled) {
        nodeResults[node.id] = { status: "skipped" };
        emit({ type: "node_skipped", nodeId: node.id, result: nodeResults[node.id] });
        continue;
      }
      emit({ type: "node_started", nodeId: node.id });
      if (node.type !== "trigger" && node.type !== "report") {
        const ancestors = ancestorsOf(node.id);
        const fromStep = boundSources.get(node.id);
        if (fromStep && !ancestors.has(fromStep)) throw new Error(`Step ${node.id} input must reference a connected predecessor.`);
        const priorOutputs = outputs.filter(output => ancestors.has(output.nodeId) && (!fromStep || output.nodeId === fromStep));
        const priorReports = fromStep ? reportByNode.get(fromStep) ?? [] : ancestorReports(node.id);
        const priorFindings = priorReports.flatMap(report => report.findings).map(finding => ({ id: finding.id, title: finding.title, category: finding.category, description: finding.description }));
        const requestedPlan = node.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN;
        const baseline = ledger.totalCostUsd();
        // Assessment descendants check totalCostUsd() against an absolute root
        // ceiling, including spend already incurred by preceding steps.
        const plan: ScanPlan = { ...copy(requestedPlan),
          timeCapMs: Math.max(1, Math.min(requestedPlan.timeCapMs, deadline - Date.now())),
          costCapUsd: baseline + Math.min(requestedPlan.costCapUsd, Math.max(0, costCapUsd - baseline)),
        };
        const stepController = new AbortController();
        const stepSignal = AbortSignal.any([controller.signal, stepController.signal]);
        const stopForStepCost = () => {
          if (ledger.hasUnpricedUsage()) stepController.abort(new WorkflowLimitError("Workflow step provider usage is unpriced; cannot enforce its cost ceiling."));
          else if (ledger.totalCostUsd() >= plan.costCapUsd) stepController.abort(new WorkflowLimitError("Workflow step cost ceiling exceeded."));
        };
        const unsubscribeStepCost = ledger.onSpend(stopForStepCost);
        stopForStepCost();
        const stepDeadline = Math.min(deadline, Date.now() + plan.timeCapMs);
        const stepTimer = setTimeout(() => stepController.abort(new WorkflowLimitError("Workflow step deadline exceeded.")), Math.min(plan.timeCapMs, 2_147_483_647));
        stepTimer.unref?.();
        try {
          const result = await withWorkflowAuditExecutionPolicy(node.execution, () => executors[node.type as SecurityWorkflowOperation]!({ node: copy(node), target, plan, signal: stepSignal, deadline: stepDeadline, costLedger: ledger, priorFindings: copy(priorFindings), priorReports: copy(priorReports), inputs: copy(stepBindings.get(node.id)!), priorOutputs: copy(priorOutputs) }));
          nodeResults[node.id] = copy(result);
          if (result.outputs?.length) outputs.push({ nodeId: node.id, outputs: copy(result.outputs) });
          const stepReports = copy(result.reports ?? []);
          reportByNode.set(node.id, stepReports);
          reports.push(...stepReports);
          findings.push(...stepReports.flatMap(report => report.findings));
          if (result.status === "cancelled" && !stepSignal.aborted) controller.abort(new Error(result.error ?? "Workflow step cancelled execution."));
          if (result.status !== "completed" || stepReports.some(report => report.executionSuccessful === false || report.costCeilingExceeded === true)) {
            throw new Error(result.error ?? "Assessment did not complete successfully.");
          }
          stepSignal.throwIfAborted();
        } catch (cause) {
          nodeResults[node.id] = { ...nodeResults[node.id], status: stepSignal.aborted && !(stepSignal.reason instanceof WorkflowLimitError) ? "cancelled" : "failed", error: message(stepSignal.aborted ? stepSignal.reason : cause) };
          emit({ type: "node_failed", nodeId: node.id, result: nodeResults[node.id] });
          throw stepSignal.aborted ? stepSignal.reason : cause;
        } finally {
          clearTimeout(stepTimer);
          unsubscribeStepCost();
        }
      } else {
        nodeResults[node.id] = { status: "completed" };
        if (node.type === "report") emit({ type: "report", nodeId: node.id, findings: ancestorReports(node.id).flatMap(report => report.findings) });
      }
      emit({ type: "node_completed", nodeId: node.id, result: nodeResults[node.id] });
    }
  } catch (cause) {
    status = controller.signal.aborted && !(controller.signal.reason instanceof WorkflowLimitError) ? "cancelled" : "failed";
    error = message(controller.signal.aborted ? controller.signal.reason : cause);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    options.signal?.removeEventListener("abort", forwardAbort);
  }
  // Every terminal snapshot resolves all nodes, including work that never
  // dispatched after a failed or cancelled predecessor.
  for (const node of nodes) if (!nodeResults[node.id]) {
    nodeResults[node.id] = { status: !node.enabled ? "skipped" : status === "cancelled" ? "cancelled" : "blocked" };
  }
  findings.sort(compareFindingsByBusinessPriority);
  const report: ScanReport | undefined = reports.length ? {
    target, scanDepth: reports[reports.length - 1]!.scanDepth,
    startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - started,
    summary: { totalAttacks: reports.reduce((sum, entry) => sum + entry.summary.totalAttacks, 0), totalFindings: findings.length,
      critical: findings.filter(f => f.severity === "critical").length, high: findings.filter(f => f.severity === "high").length,
      medium: findings.filter(f => f.severity === "medium").length, low: findings.filter(f => f.severity === "low").length, info: findings.filter(f => f.severity === "info").length },
    findings: copy(findings), warnings: reports.flatMap(entry => entry.warnings),
    executionSuccessful: status === "completed",
    ...(status === "cancelled" ? { exitReason: "cancelled" as const } : status === "failed" ? { exitReason: "failed" as const } : {}),
  } : undefined;
  return { workflow, target, status, nodeResults, reports, outputs, inputs, findings, ...(report ? { report } : {}), ...(error ? { error } : {}), ...(!ledger.hasUnpricedUsage() ? { costUsd: ledger.runCostUsd() } : {}), durationMs: Date.now() - started };
}
