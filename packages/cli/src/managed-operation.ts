import { SecurityWorkflowStore } from "@0/db";
import { executeWorkflow, type WorkflowAssessmentContext, type WorkflowRunStatus } from "@0/core";
import type { ScanReport, SecurityWorkflowInput } from "@0/shared";

export interface ManagedOperationOptions<T> {
  type: "fix" | "verify" | "research" | "deep-review";
  name: string;
  fixMode?: "candidate" | "apply";
  target: string;
  timeCapMs: number;
  costCapUsd?: number;
  controlDbPath?: string;
  signal?: AbortSignal;
  /** Portable evidence only; provider credentials and effect approval stay in the callback. */
  inputs?: Record<string, unknown>;
  execute(context: WorkflowAssessmentContext): Promise<T>;
  status?(result: T): WorkflowRunStatus;
  output?(result: T): unknown;
  reports?(result: T): ScanReport[];
}
export interface ManagedOperationDependencies {
  store(path?: string): Pick<SecurityWorkflowStore, "createExecutionFromSnapshot" | "saveExecutionResults" | "updateExecution" | "getExecution" | "close">;
}

/** Preserve command-specific engine results while retaining a common one-operation run. */
export async function executeManagedOperation<T>(options: ManagedOperationOptions<T>, dependencies: ManagedOperationDependencies = { store: path => new SecurityWorkflowStore(path) }): Promise<T> {
  const costCapUsd = options.costCapUsd ?? 1_000;
  const workflow: SecurityWorkflowInput = {
    id: `cli-${options.type}`, revision: 1, name: options.name, instructions: "", target: options.target,
    nodes: [
      { id: "start", type: "trigger", label: "Start", enabled: true },
      { id: "operation", type: options.type, label: options.name, enabled: true,
        ...(options.type === "fix" ? { fix: { mode: options.fixMode ?? "candidate" } } : {}),
        plan: { goal: "unknown-vulnerabilities", depth: "default", runCount: 1, executionMode: "sequential",
          timeCapMs: Math.min(options.timeCapMs, 86_400_000), costCapUsd: Math.min(costCapUsd, 1_000) } },
    ], edges: [{ source: "start", target: "operation" }],
  };
  const store = dependencies.store(options.controlDbPath);
  let id: string | undefined;
  let value: T | undefined;
  let produced = false;
  let engineStatus: WorkflowRunStatus = "completed";
  try {
    id = store.createExecutionFromSnapshot(workflow, "cli").id;
    store.updateExecution(id, { status: "running", nodeResults: { start: { status: "completed" }, operation: { status: "running" } } });
    const result = await executeWorkflow({ workflow, inputs: options.inputs, signal: options.signal,
      timeCapMs: options.timeCapMs, costCapUsd,
      executors: { [options.type]: async (context: WorkflowAssessmentContext) => {
        value = await options.execute(context);
        produced = true;
        engineStatus = options.status?.(value) ?? "completed";
        return { status: engineStatus, ...(options.reports ? { reports: options.reports(value) } : {}), outputs: [{ kind: options.type === "fix" ? "source-fix-result" : options.type === "verify" ? "verification-result" : `${options.type}-result`, value: options.output ? options.output(value) : value }] };
      } },
    });
    const nodeResults = Object.fromEntries(Object.entries(result.nodeResults).map(([nodeId, node]) => [nodeId, { status: node.status, ...(node.error ? { error: node.error.slice(0, 16_000) } : {}) }]));
    try { store.saveExecutionResults(id, result); }
    catch (error) {
      const message = `Run ${result.status}, but result retention failed: ${error instanceof Error ? error.message : String(error)}`;
      store.updateExecution(id, { status: result.status, nodeResults, error: message.slice(0, 16_000) });
      throw new Error(message);
    }
    store.updateExecution(id, { status: result.status, nodeResults, ...(result.error ? { error: result.error.slice(0, 16_000) } : {}) });
    if (!produced || (result.status !== "completed" && engineStatus === "completed")) throw new Error(result.error ?? "Operation did not complete.");
    return value as T;
  } catch (error) {
    const current = id ? store.getExecution(id) : undefined;
    if (id && (current?.status === "queued" || current?.status === "running")) store.updateExecution(id, { status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 16_000) });
    throw error;
  } finally { store.close(); }
}
