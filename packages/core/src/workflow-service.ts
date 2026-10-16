import { randomUUID } from "node:crypto";
import { executeWorkflow } from "./workflow-runner.js";
import type { ExecuteWorkflowOptions, WorkflowRunResult, WorkflowRunnerEvent } from "./workflow-runner.js";

export interface WorkflowServiceEvent extends WorkflowRunnerEvent { sequence: number; timestamp: string }
export interface WorkflowServiceRun {
  id: string;
  ownerId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  workflow: ExecuteWorkflowOptions["workflow"];
  target: string;
  inputs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Host controller accepted cancellation; terminal status still waits for executor cleanup. */
  cancellationRequestedAt?: string;
  events: WorkflowServiceEvent[];
  oldestSequence: number;
  eventsTruncated: boolean;
  result?: WorkflowRunResult;
  error?: string;
}
export interface WorkflowServiceOptions {
  /** Retained history callback; credentials and executors never enter snapshots. */
  onChange?: (run: WorkflowServiceRun) => void | Promise<void>;
}
interface ManagedRun {
  view: WorkflowServiceRun;
  controller: AbortController;
  promise: Promise<WorkflowRunResult>;
  persist: Promise<void>;
  sequence: number;
}

/** Owned in-process lifecycle shared by browser, CLI, and MCP adapters. */
export class WorkflowService {
  private readonly runs = new Map<string, ManagedRun>();
  private readonly keys = new Map<string, { id: string; request: string }>();
  private disposed = false;
  constructor(private readonly options: WorkflowServiceOptions = {}) {}

  start(ownerId: string, options: ExecuteWorkflowOptions, launch: { id?: string; idempotencyKey?: string } = {}): WorkflowServiceRun {
    if (this.disposed) throw new Error("Workflow service is shutting down.");
    if (!ownerId) throw new Error("A workflow run requires an owner.");
    const key = launch.idempotencyKey ? JSON.stringify([ownerId, launch.idempotencyKey]) : undefined;
    const request = JSON.stringify({ workflow: options.workflow, target: options.target, timeCapMs: options.timeCapMs, costCapUsd: options.costCapUsd, inputs: options.inputs });
    const existing = key ? this.keys.get(key) : undefined;
    if (existing) {
      if (existing.request !== request) throw new Error("Idempotency key already belongs to a different workflow request.");
      return this.get(ownerId, existing.id);
    }
    if (this.runs.size >= 256) {
      const oldest = [...this.runs.values()].find(run => run.view.status !== "queued" && run.view.status !== "running");
      if (!oldest) throw new Error("Workflow run retention is full; finish or cancel an active run.");
      this.runs.delete(oldest.view.id);
      for (const [storedKey, value] of this.keys) if (value.id === oldest.view.id) this.keys.delete(storedKey);
    }
    const id = launch.id ?? randomUUID();
    if (this.runs.has(id)) throw new Error("Workflow run ID already exists.");
    const now = new Date().toISOString();
    const controller = new AbortController();
    const view: WorkflowServiceRun = { id, ownerId, workflow: structuredClone(options.workflow), target: options.target ?? options.workflow.target, inputs: structuredClone(options.inputs ?? {}), status: "queued", createdAt: now, updatedAt: now, events: [], oldestSequence: 1, eventsTruncated: false };
    const managed: ManagedRun = { view, controller, promise: undefined as unknown as Promise<WorkflowRunResult>, persist: Promise.resolve(), sequence: 0 };
    this.runs.set(id, managed);
    if (key) this.keys.set(key, { id, request });
    this.changed(managed);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    managed.promise = Promise.resolve().then(async () => {
      view.status = "running";
      this.changed(managed);
      const result = await executeWorkflow({ ...options, workflow: structuredClone(view.workflow), inputs: structuredClone(view.inputs), signal, onEvent: event => {
        view.events.push({ ...event, sequence: ++managed.sequence, timestamp: new Date().toISOString() });
        if (view.events.length > 1000) {
          view.events.shift();
          view.eventsTruncated = true;
          view.oldestSequence = view.events[0]!.sequence;
        }
        this.changed(managed);
        options.onEvent?.(event);
      } });
      view.result = result;
      view.status = result.status;
      view.error = result.error;
      this.changed(managed);
      await managed.persist;
      return structuredClone(result);
    }).catch(async (cause: unknown) => {
      view.status = signal.aborted ? "cancelled" : "failed";
      view.error = cause instanceof Error ? cause.message : String(cause);
      this.changed(managed);
      await managed.persist;
      throw cause;
    });
    // Long-lived hosts poll status; an unobserved validation error must not
    // become an unhandled rejection that terminates the stdio transport.
    void managed.promise.catch(() => {});
    return structuredClone(view);
  }

  get(ownerId: string, id: string, after = 0): WorkflowServiceRun {
    const view = this.require(ownerId, id).view;
    return structuredClone({ ...view, events: view.events.filter(event => event.sequence > after) });
  }
  getResults(ownerId: string, id: string): WorkflowRunResult | undefined {
    const result = this.require(ownerId, id).view.result;
    return result ? structuredClone(result) : undefined;
  }
  cancel(ownerId: string, id: string): WorkflowServiceRun {
    const managed = this.require(ownerId, id);
    if ((managed.view.status === "queued" || managed.view.status === "running") && !managed.view.cancellationRequestedAt) {
      managed.view.cancellationRequestedAt = new Date().toISOString();
      managed.controller.abort(new Error("Operator cancelled this owned workflow."));
      this.changed(managed);
    }
    return this.get(ownerId, id);
  }
  wait(ownerId: string, id: string): Promise<WorkflowRunResult> { return this.require(ownerId, id).promise; }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const managed of this.runs.values()) if (managed.view.status === "queued" || managed.view.status === "running") managed.controller.abort(new Error("Workflow host disconnected."));
    await Promise.allSettled([...this.runs.values()].map(managed => managed.promise));
  }
  private require(ownerId: string, id: string): ManagedRun {
    const managed = this.runs.get(id);
    if (!managed || managed.view.ownerId !== ownerId) throw new Error("Workflow run was not found for this owner.");
    return managed;
  }
  private changed(managed: ManagedRun): void {
    managed.view.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(managed.view);
    managed.persist = managed.persist.then(() => this.options.onChange?.(snapshot));
    // Persistence failures remain observable to wait/start completion without
    // causing an unhandled rejection while an assessment is still running.
    void managed.persist.catch(() => {});
  }
}
