import type { Command } from "commander";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { SecurityWorkflowBindingsSchema, type SecurityWorkflowExecution } from "@0/shared";
import { SecurityWorkflowStore } from "@0/db";

export interface WorkflowCliRuntime {
  listTemplates(): unknown | Promise<unknown>;
  getTemplate(id: string): unknown | Promise<unknown>;
  listWorkflows(): unknown | Promise<unknown>;
  listRuns?(): unknown | Promise<unknown>;
  getWorkflow(id: string): unknown | Promise<unknown>;
  startRun(input: { templateId?: string; workflowId?: string; revision?: number; target: string; model?: string; timeCapMs?: number; costCapUsd?: number; inputs?: Record<string, unknown>; allowApply?: boolean }): SecurityWorkflowExecution | Promise<SecurityWorkflowExecution>;
  getRun(id: string): SecurityWorkflowExecution | null | Promise<SecurityWorkflowExecution | null>;
  getRunResults(id: string, page?: { cursor?: number; limit?: number }): unknown | Promise<unknown>;
  cancelRun(id: string): unknown | Promise<unknown>;
  dispose(): void | Promise<void>;
}
interface WorkflowOptions { backend?: string; backendsConfig?: string; template?: string; target?: string; revision?: string; workspace?: string; scope?: string; model?: string; timeCap?: string; costCap?: string; dbPath?: string; format?: string; templates?: boolean; inputs?: string; allowApply?: boolean }
export interface WorkflowCommandDeps {
  createRemoteRuntime?(options: { backendId: string; configPath?: string }): Promise<WorkflowCliRuntime>;
  createRuntime(options: { ownerId: string; workspace?: string; scopePath?: string; dbPath?: string; model?: string; timeCapMs?: number; costCapUsd?: number; allowApply?: boolean }): Promise<WorkflowCliRuntime>;
  out(text: string): void;
  err(text: string): void;
  sleep(): Promise<void>;
}
const defaults: WorkflowCommandDeps = {
  createRemoteRuntime: async options => (await import("../remote-workflow-runtime.js")).createRemoteWorkflowRuntime(options),
  createRuntime: async options => {
    const { createCliWorkflowRuntime } = await import("../workflow-runtime.js");
    return await createCliWorkflowRuntime(options);
  },
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  sleep: () => new Promise(resolve => setTimeout(resolve, 100)),
};
function positive(value: string | undefined, name: string, integer = false): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}.`);
  return number;
}
function output(deps: WorkflowCommandDeps, value: unknown, format?: string): void {
  if (format !== undefined && !["json", "text"].includes(format)) throw new Error("Format must be json or text.");
  // JSON preserves step statuses, evidence references and findings without a synthetic summary.
  deps.out(JSON.stringify(value, null, 2));
}
async function withRuntime(options: WorkflowOptions, deps: WorkflowCommandDeps, action: (runtime: WorkflowCliRuntime) => Promise<void>): Promise<void> {
  let runtime: WorkflowCliRuntime | undefined;
  try {
    if (options.format !== undefined && !["json", "text"].includes(options.format)) throw new Error("Format must be json or text.");
    const timeCapMs = positive(options.timeCap, "Time cap", true);
    const costCapUsd = positive(options.costCap, "Cost cap");
    if (options.backendsConfig && !options.backend) throw new Error("--backends-config requires an explicit --backend.");
    if (options.backend) {
      if (options.workspace || options.scope || options.dbPath || options.model) throw new Error("Remote workflow execution uses the backend's workspace, scope, storage and model connection; omit local execution flags.");
      if (!deps.createRemoteRuntime) throw new Error("Remote workflow transport is unavailable.");
      runtime = await deps.createRemoteRuntime({ backendId: options.backend, configPath: options.backendsConfig });
    } else {
      runtime = await deps.createRuntime({ ownerId: "cli", workspace: options.workspace, scopePath: options.scope, dbPath: options.dbPath, model: options.model, timeCapMs, costCapUsd, ...(options.allowApply ? { allowApply: true } : {}) });
    }
    await action(runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.format === "json") deps.err(JSON.stringify({ error: message }));
    else deps.err(message);
    process.exitCode = 2;
  } finally { await runtime?.dispose(); }
}
/** Read a fixed-size buffer so a file growing after stat cannot bypass the cap. */
async function readWorkflowInputs(path: string): Promise<Record<string, unknown>> {
  const maximum = 256 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Workflow inputs must be a regular JSON file.");
    if (stat.size > maximum) throw new Error("Workflow inputs must be at most 256 KiB.");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("Workflow inputs must be at most 256 KiB.");
    const inputs: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Workflow inputs must be a JSON object.");
    return SecurityWorkflowBindingsSchema.parse(inputs);
  } finally { await file.close(); }
}
export async function runWorkflowCommand(id: string | undefined, options: WorkflowOptions, deps: WorkflowCommandDeps = defaults): Promise<void> {
  await withRuntime(options, deps, async runtime => {
    if (Boolean(id) === Boolean(options.template)) throw new Error("Select exactly one saved workflow ID or --template ID.");
    const revision = positive(options.revision, "Revision", true);
    let target = options.target;
    if (!target && id) {
      const definition = await runtime.getWorkflow(id) as { target?: string } | null;
      target = definition?.target;
    }
    if (!target?.trim()) throw new Error("Supply --target or a saved workflow with a default target.");
    const inputs = options.inputs ? await readWorkflowInputs(options.inputs) : undefined;
    let runId: string | undefined;
    let cancellationRequested = false;
    const cancel = () => {
      cancellationRequested = true;
      if (runId) void Promise.resolve(runtime.cancelRun(runId)).catch(error => deps.err(String(error)));
    };
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const execution = await runtime.startRun({ templateId: options.template, workflowId: id, revision, target, model: options.model, timeCapMs: positive(options.timeCap, "Time cap", true), costCapUsd: positive(options.costCap, "Cost cap"), ...(inputs ? { inputs } : {}), ...(options.allowApply ? { allowApply: true } : {}) });
      runId = execution.id;
      if (cancellationRequested) await runtime.cancelRun(runId);
      let current = execution;
      while (current.status === "queued" || current.status === "running") {
        await deps.sleep();
        const next = await runtime.getRun(execution.id);
        if (!next) throw new Error(`Run ${execution.id} disappeared from history.`);
        current = next;
      }
      const results = await allRunResults(runtime, execution.id);
      output(deps, { run: current, results }, options.format);
      if (current.status !== "completed") process.exitCode = current.status === "cancelled" ? 130 : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  });
}
/** Foreground output and retained inspection include every result page. */
async function allRunResults(runtime: WorkflowCliRuntime, id: string): Promise<unknown> {
  const first = await runtime.getRunResults(id);
  if (!first || typeof first !== "object") return first;
  const result = { ...first } as Record<string, unknown>;
  const findings = Array.isArray(result.findings) ? [...result.findings] : [];
  let cursor = result.nextCursor;
  let previous = 0;
  while (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor <= previous) throw new Error("Invalid result pagination cursor.");
    const page = await runtime.getRunResults(id, { cursor, limit: 100 }) as Record<string, unknown>;
    if (!page || !Array.isArray(page.findings)) throw new Error("Invalid result page.");
    findings.push(...page.findings);
    previous = cursor;
    cursor = page.nextCursor;
  }
  if (Array.isArray(result.findings)) {
    result.findings = findings;
    result.nextCursor = null;
    if (result.report && typeof result.report === "object") result.report = { ...result.report, findings };
  }
  return result;
}
function inspectOptions(command: Command): Command {
  return command.option("--backend <id>", "Use a registered remote engine; targets and inputs are interpreted there").option("--backends-config <path>", "Operator backend connection registry JSON file").option("--db-path <path>", "Control database with saved workflows and run history").option("--format <format>", "Output format: json or text", "json");
}
export function registerWorkflowCommand(program: Command, deps: WorkflowCommandDeps = defaults): void {
  const workflow = program.command("workflow").description("Discover templates, inspect saved workflows, and execute a workflow");
  inspectOptions(workflow.command("list").description("List saved workflows and available templates").option("--templates", "List only templates"))
    .action(async (options: WorkflowOptions) => withRuntime(options, deps, async runtime => output(deps, options.templates ? await runtime.listTemplates() : { workflows: await runtime.listWorkflows(), templates: await runtime.listTemplates() }, options.format)));
  inspectOptions(workflow.command("show [id]").description("Show a saved workflow or template").option("--template <id>", "Show a template definition"))
    .action(async (id: string | undefined, options: WorkflowOptions) => withRuntime(options, deps, async runtime => {
      if (Boolean(id) === Boolean(options.template)) throw new Error("Select exactly one saved workflow ID or --template ID.");
      const value = options.template ? await runtime.getTemplate(options.template) : await runtime.getWorkflow(id!);
      if (!value) throw new Error("Workflow or template not found.");
      output(deps, value, options.format);
    }));
  inspectOptions(workflow.command("run [id]").description("Run a saved workflow or template in the foreground; Ctrl-C cancels it")
    .option("--template <id>", "Execute a template without saving a copy").option("--revision <revision>", "Require this workflow or template revision")
    .option("--target <target>", "Bind the authorized target").option("--workspace <path>", "Workspace for local execution")
    .option("--scope <path>", "Scope JSON file").option("--model <model>", "Configured 0 assessment model")
    .option("--inputs <path>", "Workflow artifact inputs as a JSON object (32 KiB values; 256 KiB file read limit)")
    .option("--allow-apply", "Explicitly authorize supported patch application steps for this host and run")
    .option("--time-cap <ms>", "Workflow-wide time cap in milliseconds").option("--cost-cap <usd>", "Workflow-wide cost ceiling in USD"))
    .action(async (id: string | undefined, options: WorkflowOptions) => runWorkflowCommand(id, options, deps));
  const runs = program.command("runs").description("Inspect workflow run history");
  inspectOptions(runs.command("list").description("List retained workflow runs"))
    .action(async (options: WorkflowOptions) => {
      if (options.backend || options.backendsConfig) {
        await withRuntime(options, deps, async runtime => {
          if (!runtime.listRuns) throw new Error("The selected backend does not support run listing.");
          output(deps, await runtime.listRuns(), options.format);
        });
        return;
      }
      let store: SecurityWorkflowStore | undefined;
      try { store = new SecurityWorkflowStore(options.dbPath); store.interruptActiveExecutions(); output(deps, store.listExecutions(), options.format); }
      catch (error) { deps.err(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
      finally { store?.close(); }
    });
  inspectOptions(runs.command("show <id>").description("Show a retained run and its results"))
    .action(async (id: string, options: WorkflowOptions) => withRuntime(options, deps, async runtime => {
      const run = await runtime.getRun(id);
      if (!run) throw new Error("Run not found.");
      output(deps, { run, results: await allRunResults(runtime, id) }, options.format);
    }));
  inspectOptions(runs.command("cancel <id>").description("Cancel an owned run; foreground runs use Ctrl-C, other hosts use their lifecycle API"))
    .action(async (id: string, options: WorkflowOptions) => withRuntime(options, deps, async runtime => output(deps, await runtime.cancelRun(id), options.format)));
}
