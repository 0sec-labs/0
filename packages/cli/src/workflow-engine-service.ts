import { createHash } from "node:crypto";
import { z } from "zod";
import { SecurityWorkflowBindingsSchema } from "@0/shared";
import { createCliWorkflowRuntime, type CliWorkflowRuntimeOptions } from "./workflow-runtime.js";

export interface WorkflowEngineServiceOptions {
  /** Server credential, never a caller-supplied owner or workflow input. */
  token: string;
  workspace?: string;
  scopePath?: string;
  target?: string;
  dbPath?: string;
  model?: string;
  allowApply?: boolean;
  timeCapMs?: number;
  costCapUsd?: number;
}
type Runtime = Awaited<ReturnType<typeof createCliWorkflowRuntime>>;
type RuntimeFactory = (options: CliWorkflowRuntimeOptions) => Promise<Runtime>;
const id = z.string().trim().min(1).max(160);
const startSchema = z.object({
  templateId: id.optional(), workflowId: id.optional(), revision: z.number().int().positive().optional(),
  target: z.string().trim().min(1).max(4096), inputs: SecurityWorkflowBindingsSchema.optional(),
  idempotencyKey: id.optional(), allowApply: z.boolean().optional(),
  timeCapMs: z.number().int().positive().max(86_400_000).optional(), costCapUsd: z.number().positive().max(1000).optional(),
}).strict();

/** Persistent authenticated engine ownership; clients detach without cancelling its runs. */
export class WorkflowEngineService {
  readonly ready: Promise<void>;
  readonly #runtime: Promise<Runtime>;
  #disposed = false;
  constructor(options: WorkflowEngineServiceOptions, createRuntime: RuntimeFactory = createCliWorkflowRuntime) {
    if (typeof options.token !== "string" || options.token.length < 32 || options.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(options.token)) throw new Error("Workflow engine access requires a configured secret of 32–4096 characters.");
    if (options.timeCapMs !== undefined) z.number().int().positive().max(86_400_000).parse(options.timeCapMs);
    if (options.costCapUsd !== undefined) z.number().positive().max(1000).parse(options.costCapUsd);
    const { token, ...configuration } = options;
    const ownerId = `engine:${createHash("sha256").update(token).digest("hex")}`;
    // The browser service already recovers shared history during server initialization.
    this.#runtime = createRuntime({ ...configuration, timeCapMs: options.timeCapMs ?? 600_000, costCapUsd: options.costCapUsd ?? 5, ownerId, recoverInterrupted: false });
    this.ready = this.#runtime.then(() => undefined);
  }
  async invoke(name: string, raw: Record<string, unknown>): Promise<unknown> {
    if (this.#disposed) throw new Error("Workflow engine is shutting down.");
    const runtime = await this.#runtime;
    if (this.#disposed) throw new Error("Workflow engine is shutting down.");
    if (["list_templates", "list_workflows", "list_runs"].includes(name)) {
      z.object({}).strict().parse(raw);
      return name === "list_templates" ? runtime.listTemplates() : name === "list_workflows" ? runtime.listWorkflows() : runtime.listRuns();
    }
    if (name === "get_template" || name === "get_workflow") {
      const { id: selected } = z.object({ id }).strict().parse(raw);
      return name === "get_template" ? runtime.getTemplate(selected) : runtime.getWorkflow(selected);
    }
    if (name === "save_workflow") {
      const request = z.object({ definition: z.record(z.unknown()), expectedRevision: z.number().int().positive().optional() }).strict().parse(raw);
      return runtime.saveWorkflow(request.definition, request.expectedRevision);
    }
    if (name === "start_run") {
      const request = startSchema.parse(raw);
      if (Boolean(request.templateId) === Boolean(request.workflowId)) throw new Error("Select exactly one templateId or workflowId.");
      if (request.workflowId && !request.revision) throw new Error("Saved workflow runs require a pinned revision.");
      return runtime.startRun(request);
    }
    if (["get_run", "get_run_results", "cancel_run"].includes(name)) {
      const request = z.object({ runId: id, cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(raw);
      if (name === "get_run_results") return runtime.getRunResults(request.runId, { cursor: request.cursor, limit: request.limit });
      return name === "get_run" ? runtime.getRun(request.runId) : runtime.cancelRun(request.runId);
    }
    throw new Error("Unknown workflow engine operation.");
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const runtime = await this.#runtime;
    await runtime.dispose();
  }
}
