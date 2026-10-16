import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { EngineService, ENGINE_OPERATIONS, EngineStartRunSchema, EngineAssessmentSchema, loadScope, getScopeEnforcementState, type EngineStartRun } from "@0/core";
import { createEngineCapabilityManifest } from "@0/shared";
import type { ConsoleGateway } from "./web/console-gateway.js";
import type { WebWorkflowService } from "./web/workflows.js";
import { resolveEngagement } from "./engagement-plan.js";

export interface WorkflowEngineServiceOptions {
  token: string; workspace?: string; scopePath?: string; target?: string; dbPath?: string; model?: string;
  allowApply?: boolean; timeCapMs?: number; costCapUsd?: number;
}
export interface WorkflowEngineHost { gateway: ConsoleGateway; workflows: WebWorkflowService }
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
/** Transport facade over the very same sessions and runs used by the browser. */
export class WorkflowEngineService {
  readonly ready: Promise<void>;
  readonly #engine: EngineService;
  readonly #sessions = new Map<string, Promise<string>>();
  #disposed = false;
  constructor(private readonly options: WorkflowEngineServiceOptions, private readonly host: WorkflowEngineHost) {
    if (typeof options.token !== "string" || options.token.length < 32 || options.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(options.token)) throw new Error("Engine access requires a configured secret of 32–4096 characters.");
    if (options.timeCapMs !== undefined) z.number().int().positive().max(86_400_000).parse(options.timeCapMs);
    if (options.costCapUsd !== undefined) z.number().positive().max(1000).parse(options.costCapUsd);
    this.ready = options.workspace ? realpath(options.workspace).then(() => undefined) : Promise.resolve();
    this.#engine = new EngineService({
      sessions: host.gateway, workflows: host.workflows, allowApply: options.allowApply,
      admitRun: request => this.#admitRun(request), createSession: config => this.#createSession(config),
      startAssessment: (sessionId, request) => host.workflows.launchAssessment(sessionId, request),
      resumeScan: async request => {
        const { scanId, ...input } = request;
        const timeCapMs = Math.min(typeof input.timeCapMs === "number" ? input.timeCapMs : Infinity, options.timeCapMs ?? 600_000);
        const costCapUsd = Math.min(typeof input.costCapUsd === "number" ? input.costCapUsd : Infinity, options.costCapUsd ?? 5);
        const result = await host.workflows.resumeScan(scanId as string, { ...input, timeCapMs, costCapUsd, approval: "launch-authorized-run" });
        if (result.status >= 400) throw new Error(String((result.data as { error?: string }).error ?? "Scan resume failed."));
        return result.data;
      },
      capabilities: () => createEngineCapabilityManifest({ operations: [...ENGINE_OPERATIONS, "start_assessment", "resume_scan"], reportFormats: ["json", "md", "html", "sarif", "pdf"] }),
    });
  }
  async #createSession(config: Record<string, unknown>): Promise<{ id: string }> {
    if (this.#disposed) throw new Error("Engine transport is closed.");
    if (this.options.target && config.target !== undefined && config.target !== this.options.target) throw new Error("Target does not match this engine's configured target.");
    if (this.options.scopePath && config.scope !== undefined) throw new Error("This engine owns its configured scope.");
    return this.host.gateway.create({ ...config, ...(this.options.target ? { target: this.options.target } : {}), ...(this.options.scopePath ? { scope: loadScope(this.options.scopePath).raw } : {}), ...(this.options.model ? { runtime: { model: this.options.model } } : {}) });
  }
  async #admitRun(request: EngineStartRun): Promise<string> {
    if (this.options.target && request.target.trim() !== this.options.target.trim()) throw new Error("Target does not match this engine's configured target.");
    const resolution = resolveEngagement(request.target);
    if (!resolution.ok) throw new Error(resolution.message);
    const plan = resolution.plan;
    if (plan.kind === "source" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(plan.target) && !plan.target.startsWith("git@")) {
      const root = this.options.workspace ?? (request.sessionId ? undefined : process.cwd());
      if (root && !contains(await realpath(root), await realpath(plan.target))) throw new Error("Source target is outside the engine's authorized workspace.");
    } else if (!request.sessionId && plan.kind === "web") {
      if (!this.options.scopePath) throw new Error("Live workflow targets require the engine's configured scope.");
      if (!getScopeEnforcementState(this.options.workspace).enabled) throw new Error("Live workflows require scope enforcement.");
      const verdict = loadScope(this.options.scopePath).match(plan.target);
      if (!verdict.allowed) throw new Error(`Workflow target is out of scope: ${verdict.reason}`);
    } else if (!request.sessionId && plan.kind === "source" && !this.options.target) {
      throw new Error("Remote source workflows require a fixed engine target and workspace.");
    }
    if (request.sessionId) { this.host.gateway.get(request.sessionId); return request.sessionId; }
    const key = JSON.stringify([request.target, this.options.model, this.options.scopePath]);
    let pending = this.#sessions.get(key);
    if (!pending) {
      pending = this.#createSession({ target: request.target, title: `Workflow: ${request.target}` }).then(created => created.id);
      this.#sessions.set(key, pending);
      void pending.catch(() => this.#sessions.delete(key));
    }
    return pending;
  }
  async invoke(name: string, raw: Record<string, unknown>): Promise<unknown> {
    if (this.#disposed) throw new Error("Engine transport is closed.");
    await this.ready;
    if (this.#disposed) throw new Error("Engine transport is closed.");
    if (name === "start_run") {
      EngineStartRunSchema.parse(raw);
      const timeCapMs = Math.min(typeof raw.timeCapMs === "number" ? raw.timeCapMs : Infinity, this.options.timeCapMs ?? 600_000);
      const costCapUsd = Math.min(typeof raw.costCapUsd === "number" ? raw.costCapUsd : Infinity, this.options.costCapUsd ?? 5);
      return this.#engine.invoke(name, { ...raw, timeCapMs, costCapUsd });
    }
    if (name === "start_assessment") {
      const request = EngineAssessmentSchema.parse(raw);
      return this.#engine.invoke(name, { ...request, plan: { ...request.plan, timeCapMs: Math.min(request.plan.timeCapMs, this.options.timeCapMs ?? 600_000), costCapUsd: Math.min(request.plan.costCapUsd, this.options.costCapUsd ?? 5) } });
    }
    return this.#engine.invoke(name, raw);
  }
  /** Detaching a transport never tears down the engine's browser sessions or runs. */
  async dispose(): Promise<void> { this.#disposed = true; }
}
