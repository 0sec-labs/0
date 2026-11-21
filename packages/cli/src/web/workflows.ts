import { z } from "zod";
import { SECURITY_WORKFLOW_TEMPLATES, getSecurityWorkflowTemplate, parseSecurityWorkflowInput, type SecurityWorkflowExecution } from "@0/engine/shared";
import { SecurityWorkflowStore } from "@0/engine/storage";

const PREFIX = "/api/console/";
const idSchema = z.string().trim().min(1).max(160);

class WorkflowError extends Error {
  constructor(message: string, readonly status: number = 409) { super(message); }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new WorkflowError(result.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "), 400);
  return result.data;
}
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 16_000); }

/**
 * The records behind Sentinels' automations (saved definitions, their versions and retained runs) .
 * It does not execute anything: a Sentinel fires an automation by prompt (sentinel-runner),
 * and the scan pipelines and workflow graph runner are gone.
 */
export class WebWorkflowService {
  readonly #definitions: SecurityWorkflowStore;

  constructor(options: { gateway?: unknown; dbPath?: string; recoverInterrupted?: boolean } = {}) {
    this.#definitions = new SecurityWorkflowStore(options.dbPath);
    if (options.recoverInterrupted !== false) this.#definitions.interruptActiveExecutions();
  }

  /** Retained runs are read-only history; nothing here starts one. */
  getExecution(id: string): SecurityWorkflowExecution | null { return this.#definitions.getExecution(id); }
  listExecutions(): SecurityWorkflowExecution[] { return this.#definitions.listExecutions(); }
  hasActiveWork(): boolean { return false; }

  /** Session-owned lifecycle calls over the saved automation records. */
  async invokeLifecycle(sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    parse(idSchema, sessionId);
    const none = z.object({}).strict();
    if (name === "list_runs") { parse(none, args); return { runs: this.#definitions.listExecutions(undefined, sessionId) }; }
    if (name === "list_templates") { parse(none, args); return { templates: structuredClone(SECURITY_WORKFLOW_TEMPLATES) }; }
    if (name === "get_template") { const request = parse(z.object({ id: idSchema, revision: z.number().int().positive().optional() }).strict(), args); return { template: getSecurityWorkflowTemplate(request.id, request.revision) }; }
    if (name === "list_workflows") { parse(none, args); return { workflows: this.#definitions.list() }; }
    if (name === "get_workflow") { const request = parse(z.object({ id: idSchema }).strict(), args); const workflow = this.#definitions.get(request.id); if (!workflow) throw new WorkflowError("Automation definition was not found.", 404); return { workflow }; }
    if (name === "save_workflow") {
      const request = parse(z.object({ definition: z.unknown(), expectedRevision: z.number().int().positive().optional() }).strict(), args);
      const definition = parseSecurityWorkflowInput(request.definition);
      return { workflow: this.#definitions.save({ ...definition, ...(request.expectedRevision ? { revision: request.expectedRevision } : {}) }) };
    }
    if (name === "start_run" || name === "cancel_run" || name === "get_run" || name === "get_run_results") throw new WorkflowError("Automations run through Sentinels; this host does not execute workflow graphs.", 501);
    throw new WorkflowError("Unknown automation lifecycle operation.", 400);
  }

  async handle(pathname: string, method: string, input: unknown, query: URLSearchParams): Promise<{ status: number; data: unknown } | null> {
    if (!pathname.startsWith(PREFIX + "workflow-definitions") && !pathname.startsWith(PREFIX + "workflow-executions")) return null;
    try {
      return await this.#definitionRequest(pathname, method, input, query);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof WorkflowError ? error.status
        : error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 409;
      return { status, data: { error: errorMessage(error) } };
    }
  }

  /** Nothing is owned per session any more. */
  cancelSession(_sessionId: string): void {}

  async dispose(): Promise<void> { this.#definitions.close(); }

  async #definitionRequest(pathname: string, method: string, input: unknown, query: URLSearchParams): Promise<{ status: number; data: unknown }> {
    const definitionsPath = PREFIX + "workflow-definitions";
    const executionsPath = PREFIX + "workflow-executions";
    if (pathname === definitionsPath) {
      if (method === "GET") return { status: 200, data: { definitions: this.#definitions.list() } };
      if (method === "POST") return { status: 201, data: { definition: this.#definitions.save(parseSecurityWorkflowInput(input)) } };
      throw new WorkflowError("Use GET or POST for automation definitions.", 405);
    }
    if (pathname === executionsPath && method === "GET") return { status: 200, data: { executions: this.#definitions.listExecutions(query.get("workflowId") ?? undefined, query.get("sessionId") ?? undefined) } };
    const definitionRoute = pathname.match(/^\/api\/console\/workflow-definitions\/([^/]+)(?:\/(executions|versions|rollback))?$/);
    if (definitionRoute) {
      const id = parse(idSchema, decodeURIComponent(definitionRoute[1]!));
      if (definitionRoute[2] === "versions" && method === "GET") return { status: 200, data: { versions: this.#definitions.listVersions(id) } };
      if (definitionRoute[2] === "rollback" && method === "POST") {
        const request = parse(z.object({ revision: z.number().int().positive(), expectedRevision: z.number().int().positive() }).strict(), input);
        return { status: 200, data: { definition: this.#definitions.rollback(id, request.revision, request.expectedRevision) } };
      }
      if (definitionRoute[2] === "executions" && method === "GET") return { status: 200, data: { executions: this.#definitions.listExecutions(id, query.get("sessionId") ?? undefined) } };
      if (!definitionRoute[2]) {
        if (method === "GET") {
          const definition = this.#definitions.get(id);
          if (!definition) throw new WorkflowError("Automation definition was not found.", 404);
          return { status: 200, data: { definition } };
        }
        if (method === "PATCH") {
          const value = parseSecurityWorkflowInput(input);
          if (value.id !== undefined && value.id !== id) throw new WorkflowError("Automation ID does not match the request path.", 400);
          if (value.revision === undefined) throw new WorkflowError("Editing requires the reviewed automation revision.", 409);
          // Omitted ownership fields are preserved; an explicit null detaches.
          const existing = this.#definitions.get(id);
          const merged = { ...value, id };
          if (existing && input && typeof input === "object") {
            const raw = input as Record<string, unknown>;
            if (!("ownerSentinelId" in raw) && existing.ownerSentinelId) merged.ownerSentinelId = existing.ownerSentinelId;
            if (!("runIn" in raw) && existing.runIn && raw.ownerSentinelId !== null) merged.runIn = existing.runIn;
            if (!("model" in raw) && existing.model) merged.model = existing.model;
          }
          return { status: 200, data: { definition: this.#definitions.save(merged) } };
        }
        if (method === "DELETE") {
          if (!query.has("revision")) throw new WorkflowError("Deleting requires the reviewed automation revision.", 409);
          const revision = parse(z.number().int().positive(), Number(query.get("revision")));
          this.#definitions.delete(id, revision);
          return { status: 200, data: { ok: true } };
        }
      }
      throw new WorkflowError("Unsupported automation definition action.", 405);
    }
    const executionRoute = pathname.match(/^\/api\/console\/workflow-executions\/([^/]+)(\/results)?$/);
    if (executionRoute && method === "GET") {
      const id = parse(idSchema, decodeURIComponent(executionRoute[1]!));
      const sessionId = parse(idSchema, query.get("sessionId"));
      const execution = this.getExecution(id);
      if (!execution || execution.sessionId !== sessionId) throw new WorkflowError("Automation execution was not found for this thread.", 404);
      return executionRoute[2] ? { status: 200, data: { results: this.#definitions.getExecutionResults(id) } } : { status: 200, data: { execution } };
    }
    if (executionRoute) throw new WorkflowError("Unsupported automation execution action.", 405);
    throw new WorkflowError("Automation route was not found.", 404);
  }
}
