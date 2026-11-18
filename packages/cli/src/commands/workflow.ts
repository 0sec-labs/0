import { chatOption, engineOptions } from "./shared-options.js";
import { readableError } from "./error-text.js";
import { renderTable } from "./console-support.js";
import { asJson, finishedThread, printWaited, sessionLine, threadText, waitUntilSettled, type Json } from "./thread-output.js";
import type { Command } from "commander";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { SecurityWorkflowBindingsSchema } from "@0/engine/shared";

export interface WorkflowCliRuntime {
  attachSession?(id: string): unknown | Promise<unknown>;
  listSessions?(): unknown | Promise<unknown>;
  createSession?(config?: Record<string, unknown>): unknown | Promise<unknown>;
  getSession?(id: string): unknown | Promise<unknown>;
  getSessionEvents?(id: string, after?: number): unknown | Promise<unknown>;
  sendMessage?(id: string, text: string): unknown | Promise<unknown>;
  continueSession?(id: string, text?: string): unknown | Promise<unknown>;
  cancelSession?(id: string): unknown | Promise<unknown>;
  /** Explicit operator action only; never part of model-facing engine operations. */
  forceStopSession?(id: string): unknown | Promise<unknown>;
  listSavedSessions?(): unknown | Promise<unknown>;
  resumeSession?(id: string): unknown | Promise<unknown>;
  resolveDecision?(id: string, decisionId: string, response: Record<string, unknown>): unknown | Promise<unknown>;
  listTemplates(): unknown | Promise<unknown>;
  getTemplate(id: string): unknown | Promise<unknown>;
  listWorkflows(): unknown | Promise<unknown>;
  getWorkflow(id: string): unknown | Promise<unknown>;
  dispose(): void | Promise<void>;
}
interface WorkflowOptions { wait?: boolean; timeout?: string; chat?: string; engineUrl?: string; engineTokenEnv?: string; engine?: string; enginesConfig?: string; template?: string; target?: string; revision?: string; workspace?: string; model?: string; timeCap?: string; costCap?: string; dbPath?: string; format?: string; templates?: boolean; inputs?: string; allowApply?: boolean }
export interface WorkflowCommandDeps {
  createRemoteRuntime?(options: { backendId?: string; configPath?: string; engineUrl?: string; engineTokenEnv?: string; sessionId?: string }): Promise<WorkflowCliRuntime>;
  createRuntime(options: { ownerId: string; workspace?: string; dbPath?: string; model?: string; timeCapMs?: number; costCapUsd?: number; allowApply?: boolean; requireEngine?: boolean }): Promise<WorkflowCliRuntime>;
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
/** A bad flag or value: exit 2. Everything else that fails exits 1. */
class UsageError extends Error {}
function positive(value: string | undefined, name: string, integer = false): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) throw new UsageError(`${name} must be a positive ${integer ? "integer" : "number"}.`);
  return number;
}
function output(deps: WorkflowCommandDeps, value: unknown, format?: string): void {
  if (format !== undefined && !["json", "text"].includes(format)) throw new UsageError("Format must be json or text.");
  // The default machine contract stays lossless; text is only a presentation adapter.
  deps.out(format === "text" ? renderText(value) : JSON.stringify(value, null, 2));
}
/** Threads in text mode: one line for a thread, the last reply for a read; anything else falls back to the generic text. */
function outputThread(deps: WorkflowCommandDeps, value: unknown, format?: string): void {
  if (format === "text") {
    const found = asJson(value);
    if (found.session && Array.isArray(found.messages)) return deps.out(threadText(found));
    if (typeof found.id === "string" && typeof found.status === "string") return deps.out(sessionLine(found));
    if (found.session) return deps.out(sessionLine(asJson(found.session)));
  }
  output(deps, value, format);
}
function renderText(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  if (value === null || value === undefined) return `${indent}None`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}No records`;
    return value.map(item => {
      const rendered = renderText(item, depth + 1).slice(indent.length + 2);
      return `${indent}- ${rendered}`;
    }).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return `${indent}None`;
    return entries.map(([key, item]) => {
      const label = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ") || "(empty key)";
      const nested = item !== null && typeof item === "object";
      return `${indent}${label[0]!.toUpperCase()}${label.slice(1)}:${nested ? `\n${renderText(item, depth + 1)}` : ` ${String(item ?? "None").replaceAll("\n", `\n${indent}  `)}`}`;
    }).join("\n");
  }
  return `${indent}${String(value).replaceAll("\n", `\n${indent}`)}`;
}
async function withRuntime(options: WorkflowOptions, deps: WorkflowCommandDeps, action: (runtime: WorkflowCliRuntime) => Promise<void>, requireEngine = false): Promise<void> {
  let runtime: WorkflowCliRuntime | undefined;
  try {
    if (options.format !== undefined && !["json", "text"].includes(options.format)) throw new UsageError("Format must be json or text.");
    const timeCapMs = positive(options.timeCap, "Time cap", true);
    const costCapUsd = positive(options.costCap, "Cost cap");
    if (options.enginesConfig && !options.engine) throw new UsageError("--engines-config requires an explicit --engine.");
    if (options.engineTokenEnv && !options.engineUrl) throw new UsageError("--engine-token-env requires --engine-url.");
    if (options.engine || options.engineUrl) {
      if (options.workspace || options.dbPath || options.model) throw new UsageError("Remote automation execution uses the engine's workspace, storage and model connection; omit local execution flags.");
      if (!deps.createRemoteRuntime) throw new Error("Remote automation transport is unavailable.");
      runtime = await deps.createRemoteRuntime({ backendId: options.engine, configPath: options.enginesConfig, ...(options.engineUrl ? { engineUrl: options.engineUrl, engineTokenEnv: options.engineTokenEnv } : {}), ...(options.chat ? { sessionId: options.chat } : {}) });
    } else {
      runtime = await deps.createRuntime({ ownerId: "cli", workspace: options.workspace, dbPath: options.dbPath, model: options.model, timeCapMs, costCapUsd, ...(options.allowApply ? { allowApply: true } : {}), ...(requireEngine ? { requireEngine: true } : {}) });
    }
    if (options.chat && !options.engine && !options.engineUrl) {
      if (!runtime.attachSession) throw new Error("The selected engine does not support thread attachment.");
      if (!await runtime.attachSession(options.chat)) throw new Error("The selected engine thread no longer exists.");
    }
    await action(runtime);
  } catch (error) {
    const message = readableError(error instanceof Error ? error.message : String(error));
    if (options.format === "json") deps.err(JSON.stringify({ error: message }));
    else deps.err(message);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  } finally { await runtime?.dispose(); }
}
/** Read a fixed-size buffer so a file growing after stat cannot bypass the cap. */
async function readWorkflowInputs(path: string): Promise<Record<string, unknown>> {
  const maximum = 256 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Automation inputs must be a regular JSON file.");
    if (stat.size > maximum) throw new Error("Automation inputs must be at most 256 KiB.");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("Automation inputs must be at most 256 KiB.");
    const inputs: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Automation inputs must be a JSON object.");
    return SecurityWorkflowBindingsSchema.parse(inputs);
  } finally { await file.close(); }
}
function inspectOptions(command: Command, extra: { chat?: string; requiredChat?: boolean; format?: "json" | "text" } = {}): Command {
  command.option("--engine-url <url>", "Attach directly to a running trusted engine").option("--engine-token-env <name>", "Environment variable holding the attached engine token");
  engineOptions(command, { engine: "Use a registered remote engine; targets and inputs are interpreted there" });
  if (extra.chat) chatOption(command, extra.chat, extra.requiredChat);
  return command.option("--db-path <path>", "Control database of the local engine").option("--format <format>", "Output format: json or text", extra.format ?? "json");
}
export function registerWorkflowCommand(program: Command, deps: WorkflowCommandDeps = defaults): void {
  const workflow = program.command("automation").description("Discover templates and inspect saved automations");
  inspectOptions(workflow.command("list").description("List saved automations and available templates").option("--templates", "List only templates"))
    .action(async (options: WorkflowOptions) => withRuntime(options, deps, async runtime => output(deps, options.templates ? await runtime.listTemplates() : { workflows: await runtime.listWorkflows(), templates: await runtime.listTemplates() }, options.format)));
  inspectOptions(workflow.command("show [id]").description("Show a saved automation or template").option("--template <id>", "Show a template definition"))
    .action(async (id: string | undefined, options: WorkflowOptions) => withRuntime(options, deps, async runtime => {
      if (Boolean(id) === Boolean(options.template)) throw new UsageError("Select exactly one saved automation ID or --template ID.");
      const value = options.template ? await runtime.getTemplate(options.template) : await runtime.getWorkflow(id!);
      if (!value) throw new Error("Automation or template not found.");
      output(deps, value, options.format);
    }));
  const sessions = program.command("threads").description("Inspect and control threads on the selected engine");
  const sessionAction = async (options: WorkflowOptions, method: "listSessions" | "createSession" | "getSession" | "getSessionEvents" | "sendMessage" | "continueSession" | "cancelSession" | "forceStopSession" | "listSavedSessions" | "resumeSession" | "resolveDecision", args: unknown[] = []) => {
    await withRuntime(options, deps, async runtime => {
      const operation = runtime[method];
      if (!operation) throw new Error(method === "forceStopSession" ? "The selected engine does not expose operator force stop; no work was changed." : "The selected engine does not support thread lifecycle operations.");
      outputThread(deps, await (operation as (...values: unknown[]) => unknown).apply(runtime, args), options.format);
    }, true);
  };
  /** `--wait`: run `first` (a send, or nothing for a read), wait until the thread settles, then print only the reply. */
  const waitedAction = async (id: string, options: WorkflowOptions, first?: (runtime: WorkflowCliRuntime) => unknown) => withRuntime(options, deps, async runtime => {
    const seconds = Number(options.timeout ?? "600");
    if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--timeout must be a positive number of seconds.");
    if (!runtime.getSession) throw new Error("The selected engine does not support thread lifecycle operations.");
    if (first) await first(runtime);
    const snapshot = await waitUntilSettled(async () => asJson(await runtime.getSession!(id)), deps.sleep, seconds, id);
    const done = finishedThread(snapshot);
    if (done.failed || done.claimBlocked) process.exitCode = 1;
    printWaited(deps, options.format === "json", done);
  }, true);
  const waitOptions = (command: Command): Command => command.option("--wait", "Wait for the answer; stdout is the reply only (thread id and usage go to stderr)").option("--timeout <seconds>", "Maximum seconds to wait with --wait", "600");
  inspectOptions(sessions.command("list").description("List live engine threads").option("--saved", "List retained thread snapshots"), { format: "text" })
    .action(async (options: WorkflowOptions & { saved?: boolean }) => {
      if (options.format !== "text") return sessionAction(options, options.saved ? "listSavedSessions" : "listSessions");
      // Text is a table of the columns people scan for; --format json keeps every field.
      await withRuntime(options, deps, async runtime => {
        const operation = options.saved ? runtime.listSavedSessions : runtime.listSessions;
        if (!operation) throw new Error("The selected engine does not support thread lifecycle operations.");
        const threads = await (operation as () => Promise<unknown>).call(runtime);
        if (!Array.isArray(threads)) return output(deps, threads, "text");
        const cell = (value: unknown): string => typeof value === "string" ? value.replaceAll(/\s+/g, " ") : "";
        deps.out(threads.length
          ? renderTable(["ID", "STATUS", "TITLE", "FOLDER"], threads.map((row: Record<string, unknown>) => [cell(row.id), cell(row.status), cell(row.title) || "Untitled", cell(row.workspacePath)]))
          : "No threads.");
      }, true);
    });
  inspectOptions(waitOptions(sessions.command("show <id>").description("Read a thread: its status, last reply, usage and cost")), { format: "text" })
    .action(async (id: string, options: WorkflowOptions) => options.wait ? waitedAction(id, options) : sessionAction(options, "getSession", [id]));
  inspectOptions(sessions.command("create").description("Create a thread within the engine's admission grants").option("--config <path>", "Thread configuration JSON object"))
    .action(async (options: WorkflowOptions & { config?: string }) => withRuntime(options, deps, async runtime => {
      if (!runtime.createSession) throw new Error("The selected engine does not support thread lifecycle operations.");
      output(deps, await runtime.createSession(options.config ? await readWorkflowInputs(options.config) : undefined), options.format);
    }, true));
  inspectOptions(waitOptions(sessions.command("send <id> <text>").description("Send a message to a live thread")), { format: "text" })
    .action(async (id: string, text: string, options: WorkflowOptions) => options.wait ? waitedAction(id, options, runtime => runtime.sendMessage?.(id, text)) : sessionAction(options, "sendMessage", [id, text]));
  inspectOptions(waitOptions(sessions.command("continue <id> [text]").description("Continue a live thread")), { format: "text" })
    .action(async (id: string, text: string | undefined, options: WorkflowOptions) => options.wait ? waitedAction(id, options, runtime => runtime.continueSession?.(id, text)) : sessionAction(options, "continueSession", [id, text]));
  inspectOptions(sessions.command("cancel <id>").description("Explicitly cancel the thread's active work"), { format: "text" })
    .action(async (id: string, options: WorkflowOptions) => sessionAction(options, "cancelSession", [id]));
  inspectOptions(sessions.command("force-stop <id>").description("Explicitly force stop qualified owned execution for this exact live thread"), { format: "text" })
    .action(async (id: string, options: WorkflowOptions) => sessionAction(options, "forceStopSession", [id]));
  inspectOptions(sessions.command("events <id>").description("Read thread events after an optional cursor").option("--after <cursor>", "Nonnegative engine event cursor"))
    .action(async (id: string, options: WorkflowOptions & { after?: string }) => withRuntime(options, deps, async runtime => {
      const after = options.after === undefined ? undefined : Number(options.after);
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new UsageError("Event cursor must be a nonnegative integer.");
      if (!runtime.getSessionEvents) throw new Error("The selected engine does not support thread lifecycle operations.");
      output(deps, await runtime.getSessionEvents(id, after), options.format);
    }, true));
  inspectOptions(sessions.command("resume <saved-id>").description("Restore a retained snapshot as a new thread under current admission grants"), { format: "text" })
    .action(async (id: string, options: WorkflowOptions) => sessionAction(options, "resumeSession", [id]));
  inspectOptions(sessions.command("decide <id> <decision-id>").description("Respond to a pending thread decision").requiredOption("--response <path>", "Decision response JSON object"))
    .action(async (id: string, decisionId: string, options: WorkflowOptions & { response: string }) => withRuntime(options, deps, async runtime => {
      if (!runtime.resolveDecision) throw new Error("The selected engine does not support thread lifecycle operations.");
      output(deps, await runtime.resolveDecision(id, decisionId, await readWorkflowInputs(options.response)), options.format);
    }, true));
}
