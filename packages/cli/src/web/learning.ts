import { LearningStore, LearningStoreError, learningProjectId, type SecurityWorkflowStore } from "@0/db";
import { HuntMemoryStore, LearningService, type LearningServiceOptions } from "@0/core";
import { z } from "zod";

const revision = z.object({ revision: z.number().int().positive() }).strict();
const processInput = z.object({ limit: z.number().int().min(1).max(100).optional(), projectId: z.string().min(1).max(256).optional() }).strict();
type Response = { status: number; data: unknown };

/** Customer-engine-owned learning. HTTP never accepts labels or evaluation receipts. */
export class WebLearningService {
  readonly store: LearningStore;
  readonly service: LearningService;
  readonly #definitions: SecurityWorkflowStore;
  readonly #timer: ReturnType<typeof setInterval>;
  #pending: Promise<unknown> | undefined;
  #closed = false;

  constructor(definitions: SecurityWorkflowStore, options: LearningServiceOptions = {}) {
    this.#definitions = definitions;
    this.store = definitions.learningStore();
    this.service = new LearningService(this.store, options);
    this.#timer = setInterval(() => { void this.process().catch(() => undefined); }, 5000);
    this.#timer.unref();
  }

  recordChatOutcome(event: { id: string; project: string; outcome: string }): void {
    this.store.recordExperience({ idempotencyKey: `chat:${event.id}`, projectId: learningProjectId(event.project),
      kind: "chat-turn", outcome: event.outcome, evidenceStrength: "operational", summary: `Conversation turn ${event.outcome}.`, runId: event.id });
  }

  /** Called only after host authorization of a completed local source workflow. */
  retainSourceContext(root: string): void {
    if (/^(1|true)$/i.test(process.env["ZERO_DISABLE_HUNT_MEMORY"] ?? "")) return;
    this.service.importCodebaseNotes(learningProjectId(root), root, new HuntMemoryStore());
  }

  process(options: { limit?: number; projectId?: string } = {}): Promise<unknown> {
    if (this.#closed) return Promise.resolve(null);
    if (this.#pending) return this.#pending;
    this.#pending = this.service.processPending(options).finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async handle(path: string, method: string, input: unknown, query: URLSearchParams): Promise<Response | null> {
    if (path !== "/api/console/learning" && !path.startsWith("/api/console/learning/")) return null;
    try {
      if (path === "/api/console/learning" && method === "GET") {
        const workflowId = query.get("workflowId");
        const workflow = workflowId ? this.#definitions.get(workflowId) : null;
        if (workflowId && !workflow) return { status: 404, data: { error: "Workflow not found." } };
        const projectId = workflow ? learningProjectId(workflow.target || workflow.id) : query.get("projectId") ?? undefined;
        if (projectId && projectId.length > 256) return { status: 400, data: { error: "Invalid project ID." } };
        const requestedLimit = query.has("limit") ? Number(query.get("limit")) : 100;
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) return { status: 400, data: { error: "Limit must be between 1 and 200." } };
        const selection = { projectId, limit: requestedLimit };
        return { status: 200, data: {
          events: this.store.listEvents(selection).filter(event => !workflowId || event.workflowId === workflowId),
          knowledge: this.store.listKnowledge(selection),
          improvements: this.store.listCandidates(selection).filter(candidate => !workflowId || candidate.targetId === workflowId),
          worker: this.service.status(projectId),
        } };
      }
      if (path === "/api/console/learning/process" && method === "POST") return { status: 200, data: { result: await this.process(processInput.parse(input ?? {})) } };
      const knowledge = path.match(/^\/api\/console\/learning\/knowledge\/([A-Za-z0-9_.:-]+)$/);
      if (knowledge && method === "PATCH") {
        const value = z.object({ status: z.enum(["disabled", "current"]) }).strict().parse(input);
        return { status: 200, data: { knowledge: this.store.setKnowledgeStatus(knowledge[1]!, value.status) } };
      }
      const candidate = path.match(/^\/api\/console\/learning\/improvements\/([A-Za-z0-9_.:-]+)(?:\/(reject|evaluate))?$/);
      if (candidate) {
        const value = this.store.getCandidate(candidate[1]!);
        if (!value) return { status: 404, data: { error: "Improvement not found." } };
        if (!candidate[2] && method === "GET") return { status: 200, data: { improvement: value } };
        if (candidate[2] && method === "POST") {
          if (value.registry) return { status: 409, data: { error: "This improvement is owned by the evolution registry. Use the evolution CLI to change its deployment state." } };
          const expected = revision.parse(input);
          if (value.revision !== expected.revision) return { status: 409, data: { error: "Improvement changed. Reload before updating." } };
          return { status: 200, data: { improvement: candidate[2] === "reject"
            ? this.store.transitionCandidate(value.id, expected.revision, "rejected") : await this.service.evaluate(value.id) } };
        }
      }
      return { status: 405, data: { error: "Unsupported learning operation." } };
    } catch (error) {
      return { status: error instanceof z.ZodError ? 400 : error instanceof LearningStoreError ? error.statusCode : 409,
        data: { error: error instanceof LearningStoreError || error instanceof z.ZodError ? error.message : "Learning evaluation is unavailable or failed. No improvement was activated." } };
    }
  }

  async dispose(): Promise<void> { this.#closed = true; clearInterval(this.#timer); await this.#pending; this.store.close(); }
}
