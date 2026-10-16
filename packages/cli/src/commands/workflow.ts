import type { Command } from "commander";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { SecurityWorkflowBindingsSchema, type SecurityWorkflowExecution } from "@0/shared";
import { SecurityWorkflowStore } from "@0/db";

export interface WorkflowCliRuntime {
  resumeScan?(request: { sessionId: string; scanId: string; branchFromEntry?: number; timeCapMs?: number; costCapUsd?: number }): unknown | Promise<unknown>;
  attachSession?(id: string): unknown | Promise<unknown>;
  listSessions?(): unknown | Promise<unknown>;
  createSession?(config?: Record<string, unknown>): unknown | Promise<unknown>;
  getSession?(id: string): unknown | Promise<unknown>;
  getSessionEvents?(id: string, after?: number): unknown | Promise<unknown>;
  sendMessage?(id: string, text: string): unknown | Promise<unknown>;
  continueSession?(id: string, text?: string): unknown | Promise<unknown>;
  cancelSession?(id: string): unknown | Promise<unknown>;
  listSavedSessions?(): unknown | Promise<unknown>;
  resumeSession?(id: string): unknown | Promise<unknown>;
  resolveDecision?(id: string, decisionId: string, response: Record<string, unknown>): unknown | Promise<unknown>;
  listTemplates(): unknown | Promise<unknown>;
  getTemplate(id: string): unknown | Promise<unknown>;
  listWorkflows(): unknown | Promise<unknown>;
  listRuns?(): unknown | Promise<unknown>;
  getWorkflow(id: string): unknown | Promise<unknown>;
  startRun(input: { sessionId?: string; templateId?: string; workflowId?: string; revision?: number; target: string; model?: string; timeCapMs?: number; costCapUsd?: number; inputs?: Record<string, unknown>; allowApply?: boolean }): SecurityWorkflowExecution | Promise<SecurityWorkflowExecution>;
  getRun(id: string): SecurityWorkflowExecution | null | Promise<SecurityWorkflowExecution | null>;
  getRunResults(id: string, page?: { cursor?: number; limit?: number }): unknown | Promise<unknown>;
  cancelRun(id: string): unknown | Promise<unknown>;
  dispose(): void | Promise<void>;
}
interface WorkflowOptions { session?: string; engineUrl?: string; engineTokenEnv?: string; backend?: string; backendsConfig?: string; template?: string; target?: string; revision?: string; workspace?: string; scope?: string; model?: string; timeCap?: string; costCap?: string; dbPath?: string; format?: string; templates?: boolean; inputs?: string; allowApply?: boolean }
export interface WorkflowCommandDeps {
  createRemoteRuntime?(options: { backendId?: string; configPath?: string; engineUrl?: string; engineTokenEnv?: string; sessionId?: string }): Promise<WorkflowCliRuntime>;
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
    if (options.engineTokenEnv && !options.engineUrl) throw new Error("--engine-token-env requires --engine-url.");
    if (options.backend || options.engineUrl) {
      if (options.workspace || options.scope || options.dbPath || options.model) throw new Error("Remote workflow execution uses the backend's workspace, scope, storage and model connection; omit local execution flags.");
      if (!deps.createRemoteRuntime) throw new Error("Remote workflow transport is unavailable.");
      runtime = await deps.createRemoteRuntime({ backendId: options.backend, configPath: options.backendsConfig, ...(options.engineUrl ? { engineUrl: options.engineUrl, engineTokenEnv: options.engineTokenEnv } : {}), ...(options.session ? { sessionId: options.session } : {}) });
    } else {
      runtime = await deps.createRuntime({ ownerId: "cli", workspace: options.workspace, scopePath: options.scope, dbPath: options.dbPath, model: options.model, timeCapMs, costCapUsd, ...(options.allowApply ? { allowApply: true } : {}) });
    }
    if (options.session && !options.backend && !options.engineUrl) {
      if (!runtime.attachSession) throw new Error("The selected engine does not support session attachment.");
      if (!await runtime.attachSession(options.session)) throw new Error("The selected engine session no longer exists.");
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
      const execution = await runtime.startRun({ ...(options.session ? { sessionId: options.session } : {}), templateId: options.template, workflowId: id, revision, target, model: options.model, timeCapMs: positive(options.timeCap, "Time cap", true), costCapUsd: positive(options.costCap, "Cost cap"), ...(inputs ? { inputs } : {}), ...(options.allowApply ? { allowApply: true } : {}) });
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
  return command.option("--engine-url <url>", "Attach directly to a running trusted engine").option("--engine-token-env <name>", "Environment variable holding the attached engine token").option("--backend <id>", "Use a registered remote engine; targets and inputs are interpreted there").option("--backends-config <path>", "Operator backend connection registry JSON file").option("--db-path <path>", "Control database with saved workflows and run history").option("--format <format>", "Output format: json or text", "json");
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
    .option("--session <id>", "Attach the run to an existing session on the selected engine")
    .option("--template <id>", "Execute a template without saving a copy").option("--revision <revision>", "Require this workflow or template revision")
    .option("--target <target>", "Bind the authorized target").option("--workspace <path>", "Workspace for local execution")
    .option("--scope <path>", "Scope JSON file").option("--model <model>", "Configured 0 assessment model")
    .option("--inputs <path>", "Workflow artifact inputs as a JSON object (32 KiB values; 256 KiB file read limit)")
    .option("--allow-apply", "Explicitly authorize supported patch application steps for this host and run")
    .option("--time-cap <ms>", "Workflow-wide time cap in milliseconds").option("--cost-cap <usd>", "Workflow-wide cost ceiling in USD"))
    .action(async (id: string | undefined, options: WorkflowOptions) => runWorkflowCommand(id, options, deps));
  const sessions = program.command("sessions").description("Inspect and control sessions on the selected engine");
  const sessionAction = async (options: WorkflowOptions, method: "listSessions" | "createSession" | "getSession" | "getSessionEvents" | "sendMessage" | "continueSession" | "cancelSession" | "listSavedSessions" | "resumeSession" | "resolveDecision", args: unknown[] = []) => {
    await withRuntime(options, deps, async runtime => {
      const operation = runtime[method];
      if (!operation) throw new Error("The selected engine does not support session lifecycle operations.");
      output(deps, await (operation as (...values: unknown[]) => unknown).apply(runtime, args), options.format);
    });
  };
  inspectOptions(sessions.command("list").description("List live engine sessions").option("--saved", "List retained session snapshots"))
    .action(async (options: WorkflowOptions & { saved?: boolean }) => sessionAction(options, options.saved ? "listSavedSessions" : "listSessions"));
  inspectOptions(sessions.command("show <id>").description("Read a live session without recreating it"))
    .action(async (id: string, options: WorkflowOptions) => sessionAction(options, "getSession", [id]));
  inspectOptions(sessions.command("create").description("Create a session within the engine's admission grants").option("--config <path>", "Session configuration JSON object"))
    .action(async (options: WorkflowOptions & { config?: string }) => withRuntime(options, deps, async runtime => {
      if (!runtime.createSession) throw new Error("The selected engine does not support session lifecycle operations.");
      output(deps, await runtime.createSession(options.config ? await readWorkflowInputs(options.config) : undefined), options.format);
    }));
  inspectOptions(sessions.command("send <id> <text>").description("Send a message to a live session"))
    .action(async (id: string, text: string, options: WorkflowOptions) => sessionAction(options, "sendMessage", [id, text]));
  inspectOptions(sessions.command("continue <id> [text]").description("Continue a live session"))
    .action(async (id: string, text: string | undefined, options: WorkflowOptions) => sessionAction(options, "continueSession", [id, text]));
  inspectOptions(sessions.command("cancel <id>").description("Explicitly cancel the session's active work"))
    .action(async (id: string, options: WorkflowOptions) => sessionAction(options, "cancelSession", [id]));
  inspectOptions(sessions.command("events <id>").description("Read session events after an optional cursor").option("--after <cursor>", "Nonnegative engine event cursor"))
    .action(async (id: string, options: WorkflowOptions & { after?: string }) => withRuntime(options, deps, async runtime => {
      const after = options.after === undefined ? undefined : Number(options.after);
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error("Event cursor must be a nonnegative integer.");
      if (!runtime.getSessionEvents) throw new Error("The selected engine does not support session lifecycle operations.");
      output(deps, await runtime.getSessionEvents(id, after), options.format);
    }));
  inspectOptions(sessions.command("resume <saved-id>").description("Restore a retained snapshot as a new session under current admission grants"))
    .action(async (id: string, options: WorkflowOptions) => sessionAction(options, "resumeSession", [id]));
  inspectOptions(sessions.command("decide <id> <decision-id>").description("Respond to a pending session decision").requiredOption("--response <path>", "Decision response JSON object"))
    .action(async (id: string, decisionId: string, options: WorkflowOptions & { response: string }) => withRuntime(options, deps, async runtime => {
      if (!runtime.resolveDecision) throw new Error("The selected engine does not support session lifecycle operations.");
      output(deps, await runtime.resolveDecision(id, decisionId, await readWorkflowInputs(options.response)), options.format);
    }));
  const runs = program.command("runs").description("Inspect workflow run history");
  inspectOptions(runs.command("resume <scan-id>").description("Resume a persisted scan in an existing engine session")
    .requiredOption("--session <id>", "Existing engine session")
    .option("--branch-from-entry <index>", "Nonnegative retained history entry index")
    .option("--time-cap <ms>", "Resume time ceiling in milliseconds")
    .option("--cost-cap <usd>", "Resume cost ceiling in USD"))
    .action(async (scanId: string, options: WorkflowOptions & { session: string; branchFromEntry?: string }) => withRuntime(options, deps, async runtime => {
      if (!runtime.resumeScan) throw new Error("The selected engine does not support persisted scan resume.");
      const branchFromEntry = options.branchFromEntry === undefined ? undefined : Number(options.branchFromEntry);
      if (branchFromEntry !== undefined && (!Number.isSafeInteger(branchFromEntry) || branchFromEntry < 0)) throw new Error("Branch entry must be a nonnegative integer.");
      output(deps, await runtime.resumeScan({ sessionId: options.session, scanId, ...(branchFromEntry !== undefined ? { branchFromEntry } : {}), ...(options.timeCap ? { timeCapMs: positive(options.timeCap, "Time cap", true) } : {}), ...(options.costCap ? { costCapUsd: positive(options.costCap, "Cost cap") } : {}) }), options.format);
    }));
  inspectOptions(runs.command("list").description("List retained workflow runs"))
    .action(async (options: WorkflowOptions) => {
      if (options.backend || options.backendsConfig || options.engineUrl || options.engineTokenEnv) {
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
