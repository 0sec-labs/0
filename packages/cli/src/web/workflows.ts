import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { validateScanPlan, type Finding, type ScanReport } from "@0/shared";
import {
  applySourceFixCandidate,
  loadSourceFixProjectInputs,
  planSourceFixPublication,
  publishSourceFixDraftPR,
  resolveSourceFixRepository,
  runSourceFix,
  saveSourceFixProjectInputs,
  verifySourceFixCandidate,
  withScopeEnforcement,
  type NativeRuntime,
  type ScopeEnforcementState,
  type ScopePolicy,
  type SourceFixPublicationPlan,
  type SourceFixResult,
} from "@0/core";
import { runUnified, type RunOutcome } from "../commands/run.js";
import { resolveEngagement } from "../engagement-plan.js";
import { loadFindingFocus } from "../finding-focus.js";
import { fixEligibility } from "../tui/fix-action.js";

const execFileAsync = promisify(execFile);
const PREFIX = "/api/console/";
const MAX_JOBS = 40;
const MAX_FIXES = 24;
const MAX_ACTIVE = 8;
const MAX_EVENTS = 200;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const idSchema = z.string().trim().min(1).max(160);
const planSchema = z.object({
  goal: z.enum(["known-vulnerabilities", "unknown-vulnerabilities", "misconfigurations"]),
  depth: z.enum(["quick", "default", "deep"]),
  runCount: z.number().int().min(1).max(16),
  executionMode: z.enum(["sequential", "parallel"]),
  timeCapMs: z.number().int().min(1).max(RETENTION_MS),
  costCapUsd: z.number().positive().max(1000),
}).strict();
const launchSchema = z.object({
  sessionId: idSchema,
  target: z.string().trim().min(1).max(4096),
  plan: planSchema,
  approval: z.literal("launch-authorized-run"),
}).strict();
const prepareSchema = z.object({
  sessionId: idSchema,
  findingId: idSchema,
  repoRoot: z.string().trim().min(1).max(4096).optional(),
  testCommand: z.string().trim().min(1).max(4096).optional(),
}).strict();
const fixActionSchema = z.object({
  sessionId: idSchema,
  fixId: idSchema,
  reviewToken: z.string().max(128).optional(),
  candidateId: z.string().max(128).optional(),
  publicationToken: z.string().max(128).optional(),
  approval: z.enum(["generate-and-test", "run-regression", "apply-to-repository", "publish-draft-pr"]).optional(),
}).strict();
const cancelSchema = z.object({ sessionId: idSchema }).strict();

/** Server-only account/runtime data. Only the explicitly projected selection reaches HTTP. */
export interface WebWorkflowExecutionContext {
  runtime: NativeRuntime;
  model: string;
  providerId: string;
  agentModels?: Record<string, string>;
  singleModel?: boolean;
  autoRoute?: boolean;
  target: string;
  scope?: ScopePolicy;
  scopeEnforcement: ScopeEnforcementState;
  localScopePath?: string;
  status: string;
  role?: string;
  autonomyMode?: string;
  dbPath?: string;
}

export interface WebWorkflowGateway {
  getExecutionContext(id: string): Promise<WebWorkflowExecutionContext>;
  authorizeWorkflowTarget(
    id: string,
    target: { target: string; kind: string },
    signal?: AbortSignal,
    ownerId?: string,
  ): Promise<WebWorkflowExecutionContext>;
}

export interface WebWorkflowEvent {
  sequence: number;
  timestamp: string;
  type: "progress" | "report" | "state" | "error";
  data: unknown;
}

export interface WebWorkflow {
  id: string;
  sessionId: string;
  kind: "run" | "fix-propose" | "fix-verify" | "fix-apply" | "fix-publish";
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  request: unknown;
  runtime: { providerId: string; model: string; agentModels?: Record<string, string>; singleModel?: boolean; autoRoute?: boolean };
  events: WebWorkflowEvent[];
  oldestSequence: number;
  eventsTruncated: boolean;
  runs?: Array<{ scanId: string; runIndex?: number }>;
  report?: ScanReport;
  reportRetained: boolean;
  reportRetentionReason?: string;
  outcome?: Omit<RunOutcome, "report">;
  result?: { fix: WebFix };
  error?: string;
}

export interface WebFix {
  id: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  finding: Finding;
  repoRoot: string;
  baseCommit: string;
  testCommand: string;
  reviewToken: string;
  eligible: boolean;
  reason?: string;
  candidateId?: string;
  result?: SourceFixResult;
  verification?: SourceFixResult;
  applied: boolean;
  application?: SourceFixResult;
  publication?: SourceFixPublicationPlan & { publicationToken: string };
  published?: { prUrl: string; branch: string; worktree: string };
  activeWorkflowId?: string;
}

interface ManagedJob {
  view: WebWorkflow;
  controller: AbortController;
  sequence: number;
  reportBytes: number;
  settledAt?: number;
  promise?: Promise<void>;
}
interface ManagedFix {
  view: WebFix;
  dbPath: string;
  findingIdentity: string;
  context: WebWorkflowExecutionContext;
  /** Keep original object identity: core's WeakMap proves this candidate was actually verified. */
  candidate?: SourceFixResult;
}

class WorkflowError extends Error {
  constructor(message: string, readonly status: number = 409) { super(message); }
}
function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function snapshot<T>(value: T): T { return structuredClone(value); }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new WorkflowError(result.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "), 400);
  return result.data;
}
function active(job: ManagedJob): boolean {
  return job.view.status === "queued" || job.view.status === "running" || job.view.status === "cancelling";
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function selection(context: WebWorkflowExecutionContext): WebWorkflow["runtime"] {
  return snapshot({ providerId: context.providerId, model: context.model,
    ...(context.agentModels ? { agentModels: context.agentModels } : {}),
    ...(context.singleModel !== undefined ? { singleModel: context.singleModel } : {}),
    ...(context.autoRoute !== undefined ? { autoRoute: context.autoRoute } : {}) });
}
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
async function repositoryState(repoRoot: string): Promise<{ head: string; dirty: boolean }> {
  const options = { cwd: repoRoot, timeout: 5000, maxBuffer: 128 * 1024 };
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], options),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], options),
  ]);
  return { head: head.stdout.trim(), dirty: status.stdout.length > 0 };
}

/** Browser orchestration only: the existing scanners and verified source-fix services own execution. */
export class WebWorkflowService {
  readonly #gateway: WebWorkflowGateway;
  readonly #dbPath?: string;
  readonly #jobs = new Map<string, ManagedJob>();
  readonly #fixes = new Map<string, ManagedFix>();
  readonly #repositoryJobs = new Map<string, string>();

  constructor(options: { gateway: WebWorkflowGateway; dbPath?: string }) {
    this.#gateway = options.gateway;
    this.#dbPath = options.dbPath;
  }

  async handle(pathname: string, method: string, input: unknown, query: URLSearchParams): Promise<{ status: number; data: unknown } | null> {
    if (!pathname.startsWith(PREFIX + "workflows") && !pathname.startsWith(PREFIX + "fixes/")) return null;
    this.#prune();
    try {
      if (pathname === PREFIX + "workflows") {
        if (method === "GET") {
          const sessionId = parse(idSchema, query.get("sessionId"));
          return { status: 200, data: { workflows: [...this.#jobs.values()].filter(job => job.view.sessionId === sessionId).map(job => this.#project(job)) } };
        }
        if (method === "POST") return await this.#launch(input);
        return { status: 405, data: { error: "Use GET or POST for workflows." } };
      }
      const match = pathname.match(/^\/api\/console\/workflows\/([^/]+)(\/cancel)?$/);
      if (match) {
        const sessionId = match[2] ? parse(cancelSchema, input).sessionId : parse(idSchema, query.get("sessionId"));
        const job = this.#requireJob(decodeURIComponent(match[1]!), sessionId);
        if (!match[2] && method === "GET") {
          const after = Number(query.get("after") ?? "0");
          if (!Number.isSafeInteger(after) || after < 0) throw new WorkflowError("after must be a nonnegative integer.", 400);
          return { status: 200, data: { workflow: this.#project(job, after) } };
        }
        if (match[2] && method === "POST") {
          this.#cancel(job);
          return { status: 200, data: { workflow: this.#project(job) } };
        }
        return { status: 405, data: { error: match[2] ? "Use POST to cancel a workflow." : "Use GET to read a workflow." } };
      }
      if (pathname === PREFIX + "fixes/prepare") {
        if (method !== "POST") return { status: 405, data: { error: "Use POST to prepare a source fix." } };
        return await this.#prepare(input);
      }
      const fixRoute = pathname.match(/^\/api\/console\/fixes\/(propose|verify|apply|publish)$/);
      if (fixRoute) {
        if (method !== "POST") return { status: 405, data: { error: "Use POST for source-fix actions." } };
        return await this.#fixAction(fixRoute[1]!, input);
      }
      return null;
    } catch (error) {
      const status = error instanceof WorkflowError ? error.status
        : error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 409;
      return { status, data: { error: errorMessage(error) } };
    }
  }

  /** Session closure cancels its owned jobs, never another session's decisions or work. */
  cancelSession(sessionId: string): void {
    for (const job of this.#jobs.values()) if (job.view.sessionId === sessionId) this.#cancel(job);
  }

  async dispose(): Promise<void> {
    for (const job of this.#jobs.values()) this.#cancel(job);
    await Promise.all([...this.#jobs.values()].map(job => job.promise));
  }

  async #launch(input: unknown): Promise<{ status: number; data: unknown }> {
    const request = parse(launchSchema, input);
    validateScanPlan(request.plan);
    const resolution = resolveEngagement(request.target);
    if (!resolution.ok) throw new WorkflowError(resolution.message, 400);
    const context = await this.#gateway.getExecutionContext(request.sessionId);
    if (context.autonomyMode === "recon") throw new WorkflowError("Recon mode is read-only; switch modes before approving an effectful bounded scan.", 403);
    const resolved = snapshot(resolution.plan);
    const job = this.#createJob("run", request.sessionId, { ...request, resolved }, context);
    this.#start(job, async () => {
      const authorized = await this.#gateway.authorizeWorkflowTarget(request.sessionId, {
        target: resolved.kind === "package" ? request.target : resolved.target, kind: resolved.kind,
      }, job.controller.signal, job.view.id);
      if (authorized.autonomyMode === "recon") throw new WorkflowError("Recon mode cannot authorize an effectful bounded scan.", 403);
      if (resolved.kind === "source" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(resolved.target) && !resolved.target.startsWith("git@")) {
        const path = await realpath(resolved.target);
        if (authorized.scopeEnforcement.enabled && (!authorized.localScopePath || !contained(await realpath(authorized.localScopePath), path))) {
          throw new WorkflowError("Source run is outside the explicitly approved local scope.", 403);
        }
      }
      job.controller.signal.throwIfAborted();
      await withScopeEnforcement(authorized.scopeEnforcement, () => runUnified({
        target: resolved.target,
        targetType: resolved.targetType,
        reviewPackageEcosystem: resolved.ecosystem,
        depth: request.plan.depth,
        format: "json",
        runtime: "api",
        plan: snapshot(request.plan),
        nativeRuntime: context.runtime,
        model: context.model,
        agentModels: context.agentModels,
        singleModel: context.singleModel,
        autoRoute: context.autoRoute,
        scope: authorized.scope,
        timeout: request.plan.timeCapMs,
        costCeilingUsd: request.plan.costCapUsd,
        dbPath: context.dbPath ?? this.#dbPath,
        signal: job.controller.signal,
        verbose: false,
        suppressOutput: true,
        suppressUi: true,
        embedded: true,
        onEvent: event => {
          if (event && typeof event === "object" && "data" in event && event.data && typeof event.data === "object" &&
              "scanId" in event.data && typeof event.data.scanId === "string" && "persisted" in event.data && event.data.persisted === true) {
            const scanId = event.data.scanId;
            const runs = job.view.runs ??= [];
            if (!runs.some(run => run.scanId === scanId)) {
              runs.push({ scanId,
                ...("runIndex" in event && typeof event.runIndex === "number" ? { runIndex: event.runIndex } : {}) });
            }
          }
          this.#event(job, "progress", event);
        },
        onReport: report => this.#retainReport(job, report),
        onOutcome: outcome => {
          const { report: _report, ...details } = outcome;
          job.view.outcome = snapshot(details);
        },
      }));
      if (!job.view.outcome) throw new WorkflowError("Runner returned without an execution outcome.");
      const attempts = job.view.outcome.attempts;
      if (!attempts || attempts.length !== request.plan.runCount) throw new WorkflowError("Runner did not return every planned attempt outcome.");
      this.#event(job, "report", { outcome: job.view.outcome, reportRetained: job.view.reportRetained });
      if (attempts.some(attempt => attempt.status !== "completed")) {
        throw new WorkflowError(job.view.outcome.error ?? `Run plan stopped: ${job.view.outcome.exit_reason}.`);
      }
    });
    return { status: 202, data: { workflow: this.#project(job) } };
  }

  async #prepare(input: unknown): Promise<{ status: number; data: unknown }> {
    const request = parse(prepareSchema, input);
    const context = await this.#gateway.getExecutionContext(request.sessionId);
    const focus = loadFindingFocus(request.findingId, { dbPath: context.dbPath ?? this.#dbPath });
    if (Buffer.byteLength(JSON.stringify(focus.finding)) > 2 * 1024 * 1024) throw new WorkflowError("Stored finding exceeds the browser review limit; no evidence was truncated or approved.", 413);
    const repoRoot = await resolveSourceFixRepository(request.repoRoot ?? context.localScopePath ?? focus.target);
    if (!repoRoot) throw new WorkflowError("Choose a local Git worktree root for this finding.", 400);
    const state = await repositoryState(repoRoot);
    if (state.dirty) throw new WorkflowError("Source-fix preparation requires a clean repository; existing user changes were preserved.");
    const saved = request.testCommand ? undefined : loadSourceFixProjectInputs(repoRoot);
    const testCommand = request.testCommand ?? saved?.testCommand ?? "";
    const eligibility = fixEligibility(focus.finding);
    const reason = eligibility.eligible ? (!testCommand ? "Review and enter a regression command before generation." : undefined) : eligibility.reason;
    const now = new Date().toISOString();
    const id = randomUUID();
    const view: WebFix = {
      id, sessionId: request.sessionId, createdAt: now, updatedAt: now,
      finding: snapshot(focus.finding), repoRoot, baseCommit: state.head, testCommand,
      reviewToken: identity({ id, finding: focus.finding, repoRoot, head: state.head, testCommand, runtime: selection(context) }),
      eligible: eligibility.eligible && Boolean(testCommand), ...(reason ? { reason } : {}), applied: false,
    };
    if (this.#fixes.size >= MAX_FIXES) {
      const oldest = [...this.#fixes.values()].find(fix => !fix.view.activeWorkflowId);
      if (!oldest) throw new WorkflowError("Source-fix review retention is full; finish or cancel an active operation.", 429);
      this.#fixes.delete(oldest.view.id);
    }
    this.#fixes.set(id, { view, dbPath: focus.dbPath, findingIdentity: identity(focus.finding), context });
    return { status: 200, data: { fix: snapshot(view) } };
  }

  async #fixAction(action: string, input: unknown): Promise<{ status: number; data: unknown }> {
    const request = parse(fixActionSchema, input);
    const fix = this.#fixes.get(request.fixId);
    if (!fix || fix.view.sessionId !== request.sessionId) throw new WorkflowError("Source-fix review was not found for this session.", 404);
    if (fix.view.activeWorkflowId) throw new WorkflowError("This source-fix review already has an active operation.");
    if (fix.view.published) throw new WorkflowError("This source-fix candidate was already published.");
    const currentContext = await this.#gateway.getExecutionContext(request.sessionId);
    if (currentContext.autonomyMode === "recon" && !(action === "publish" && request.approval === undefined)) {
      throw new WorkflowError("Recon mode is read-only; source-fix command execution, application and publication are blocked.", 403);
    }
    await this.#assertFixCurrent(fix);
    const view = fix.view;
    if (action === "propose") {
      if (request.approval !== "generate-and-test" || request.reviewToken !== view.reviewToken) throw new WorkflowError("Explicit approval of this exact repository, finding and regression command is required.", 403);
      if (!view.eligible) throw new WorkflowError(view.reason ?? "Source-fix inputs are not eligible.");
      if (fix.candidate || view.result) throw new WorkflowError("Prepare a new review to generate another candidate.");
    } else {
      if (!fix.candidate || !view.candidateId || request.candidateId !== view.candidateId) throw new WorkflowError("A displayed, exact verified candidate identity is required.", 403);
      if (view.applied) throw new WorkflowError("This candidate was already applied; the original checkout is preserved. Prepare a new review for further changes.");
      if (action !== "verify" && view.verification && view.verification.status !== "validated_candidate") throw new WorkflowError("Candidate failed its latest verification; explicitly re-verify before applying or publishing.");
      if (action === "publish" && request.approval === undefined) {
        const plan = await planSourceFixPublication(fix.candidate);
        view.publication = { ...plan, publicationToken: identity({ candidateId: view.candidateId, plan }) };
        view.updatedAt = new Date().toISOString();
        return { status: 200, data: { fix: snapshot(view) } };
      }
      const approval = action === "verify" ? "run-regression" : action === "apply" ? "apply-to-repository" : "publish-draft-pr";
      if (request.approval !== approval) throw new WorkflowError(`Separate explicit ${approval} approval is required.`, 403);
      if (action === "publish" && (!view.publication || request.publicationToken !== view.publication.publicationToken)) {
        throw new WorkflowError("Inspect and explicitly approve the exact current publication plan before publishing.", 403);
      }
    }
    if (this.#repositoryJobs.has(view.repoRoot)) throw new WorkflowError("Another source-fix operation owns this repository; wait or cancel it.");
    const kind = `fix-${action}` as "fix-propose" | "fix-verify" | "fix-apply" | "fix-publish";
    const job = this.#createJob(kind, view.sessionId, {
      fixId: view.id, findingId: view.finding.id, repoRoot: view.repoRoot, baseCommit: view.baseCommit,
      testCommand: view.testCommand, candidateId: view.candidateId, publication: view.publication,
      approval: request.approval,
    }, fix.context);
    view.activeWorkflowId = job.view.id;
    this.#repositoryJobs.set(view.repoRoot, job.view.id);
    this.#start(job, async () => {
        const authorized = await this.#gateway.authorizeWorkflowTarget(view.sessionId, { target: view.repoRoot, kind: "source" }, job.controller.signal, job.view.id);
        if (authorized.autonomyMode === "recon") throw new WorkflowError("Recon mode cannot authorize source-fix effects.", 403);
        if (authorized.scopeEnforcement.enabled && (!authorized.localScopePath || !contained(await realpath(authorized.localScopePath), view.repoRoot))) {
          throw new WorkflowError("Source fix is outside the explicitly approved local scope.", 403);
        }
        await this.#assertFixCurrent(fix);
        job.controller.signal.throwIfAborted();
        if (action === "propose") {
          // Persistence remembers operator-owned inputs, never future execution approval.
          saveSourceFixProjectInputs({ repoRoot: view.repoRoot, testCommand: view.testCommand });
          const result = await runSourceFix({
            repoRoot: view.repoRoot, finding: snapshot(view.finding), runtime: fix.context.runtime,
            testCommand: view.testCommand, apply: false, keepWorktree: true,
            signal: job.controller.signal, onProgress: event => this.#event(job, "progress", event),
          });
          view.result = snapshot(result);
          if (result.status === "validated_candidate" && result.candidate && result.diff) {
            fix.candidate = result;
            view.candidateId = identity({ fixId: view.id, findingId: view.finding.id, candidate: result.candidate, sourceFile: result.sourceFile, diff: result.diff });
          }
          if (result.status !== "validated_candidate") throw new WorkflowError(result.error ?? `Source-fix result: ${result.status}.`);
        } else if (action === "verify") {
          this.#event(job, "progress", { stage: "revalidating-exact-candidate" });
          const verified = await verifySourceFixCandidate(fix.candidate!, { signal: job.controller.signal });
          view.verification = snapshot(verified);
          if (verified.status !== "validated_candidate") throw new WorkflowError(verified.error ?? "Candidate verification failed.");
        } else if (action === "apply") {
          this.#event(job, "progress", { stage: "revalidating-before-explicit-apply" });
          const applied = await applySourceFixCandidate(fix.candidate!, { approval: "apply-to-repository", signal: job.controller.signal });
          view.application = snapshot(applied);
          view.applied = applied.applied;
          if (applied.status !== "applied_and_retested") throw new WorkflowError(applied.error ?? "Candidate was not safely applied.");
        } else {
          this.#event(job, "progress", { stage: "revalidating-before-explicit-publication", publication: view.publication });
          view.published = await publishSourceFixDraftPR(fix.candidate!, { approval: "publish-draft-pr", signal: job.controller.signal });
        }
    }, () => {
      delete view.activeWorkflowId;
      view.updatedAt = new Date().toISOString();
      job.view.result = { fix: snapshot(view) };
      this.#repositoryJobs.delete(view.repoRoot);
    });
    return { status: 202, data: { workflow: this.#project(job), fix: snapshot(view) } };
  }

  async #assertFixCurrent(fix: ManagedFix): Promise<void> {
    const focus = loadFindingFocus(fix.view.finding.id, { dbPath: fix.dbPath });
    if (identity(focus.finding) !== fix.findingIdentity) throw new WorkflowError("Stored finding evidence changed after preparation; prepare a fresh review.");
    const state = await repositoryState(fix.view.repoRoot);
    if (state.dirty || state.head !== fix.view.baseCommit) throw new WorkflowError("Original repository changed after preparation; no user changes were overwritten.");
  }

  #createJob(kind: WebWorkflow["kind"], sessionId: string, request: unknown, context: WebWorkflowExecutionContext): ManagedJob {
    this.#prune();
    if ([...this.#jobs.values()].filter(active).length >= MAX_ACTIVE) throw new WorkflowError("Too many active browser workflows; wait or cancel one.", 429);
    if ([...this.#jobs.values()].some(job => active(job) && job.view.sessionId === sessionId)) throw new WorkflowError("This session already owns an active workflow; wait or cancel it.");
    if (this.#jobs.size >= MAX_JOBS) {
      const oldest = [...this.#jobs.values()].find(job => !active(job));
      if (!oldest) throw new WorkflowError("Browser workflow retention is full.", 429);
      this.#jobs.delete(oldest.view.id);
    }
    const now = new Date().toISOString();
    const job: ManagedJob = {
      view: { id: randomUUID(), sessionId, kind, status: "queued", createdAt: now, updatedAt: now,
        request: snapshot(request), runtime: selection(context), events: [], oldestSequence: 1, eventsTruncated: false, reportRetained: false },
      controller: new AbortController(), sequence: 0, reportBytes: 0,
    };
    this.#jobs.set(job.view.id, job);
    this.#event(job, "state", { status: "queued" });
    return job;
  }

  #start(job: ManagedJob, operation: () => Promise<void>, onSettled?: () => void): void {
    job.promise = Promise.resolve().then(async () => {
      job.controller.signal.throwIfAborted();
      job.view.status = "running";
      this.#event(job, "state", { status: "running" });
      await operation();
      // A completed irreversible action remains completed even if cancellation
      // arrived after its success. Never claim remote publication was undone.
      job.view.status = "completed";
    }).catch((error: unknown) => {
      job.view.status = job.controller.signal.aborted ? "cancelled" : "failed";
      job.view.error = errorMessage(error);
      this.#event(job, "error", { message: job.view.error });
    }).finally(() => {
      onSettled?.();
      job.settledAt = Date.now();
      this.#event(job, "state", { status: job.view.status });
    });
  }

  #cancel(job: ManagedJob): void {
    if (!active(job) || job.controller.signal.aborted) return;
    job.view.status = "cancelling";
    job.controller.abort(new Error("Operator cancelled this owned workflow."));
    this.#event(job, "state", { status: "cancelling", cancellationRequested: true });
  }

  #requireJob(id: string, sessionId: string): ManagedJob {
    const job = this.#jobs.get(id);
    if (!job || job.view.sessionId !== sessionId) throw new WorkflowError("Workflow was not found for this session.", 404);
    return job;
  }

  #project(job: ManagedJob, after = 0): WebWorkflow {
    const view = snapshot({ ...job.view, events: job.view.events.filter(event => event.sequence > after) });
    view.eventsTruncated = job.view.oldestSequence > after + 1;
    if (job.view.kind !== "run" && view.request && typeof view.request === "object" &&
        "fixId" in view.request && typeof view.request.fixId === "string") {
      const fix = this.#fixes.get(view.request.fixId);
      if (fix) view.result = { fix: snapshot(fix.view) };
    }
    return view;
  }

  #event(job: ManagedJob, type: WebWorkflowEvent["type"], data: unknown): void {
    const now = new Date().toISOString();
    const encoded = JSON.stringify(data);
    const safeData = encoded && Buffer.byteLength(encoded) > MAX_EVENT_BYTES
      ? { truncated: true, originalBytes: Buffer.byteLength(encoded), preview: encoded.slice(0, MAX_EVENT_BYTES / 2) }
      : snapshot(data);
    job.view.events.push({ sequence: ++job.sequence, timestamp: now, type, data: safeData });
    if (job.view.events.length > MAX_EVENTS) job.view.events.splice(0, job.view.events.length - MAX_EVENTS);
    job.view.oldestSequence = job.view.events[0]?.sequence ?? job.sequence + 1;
    job.view.updatedAt = now;
  }

  #retainReport(job: ManagedJob, report: ScanReport): void {
    const bytes = Buffer.byteLength(JSON.stringify(report));
    if (bytes > MAX_REPORT_BYTES) {
      job.view.reportRetentionReason = "Actual report exceeds browser memory retention; persisted scan findings and events remain available in run history.";
      this.#event(job, "report", { reportRetained: false, originalBytes: bytes, reason: job.view.reportRetentionReason });
      return;
    }
    let retained = [...this.#jobs.values()].reduce((sum, current) => sum + current.reportBytes, 0);
    for (const older of this.#jobs.values()) {
      if (retained + bytes <= MAX_REPORT_BYTES) break;
      if (older === job || !older.reportBytes) continue;
      retained -= older.reportBytes;
      delete older.view.report;
      older.reportBytes = 0;
      older.view.reportRetained = false;
      older.view.reportRetentionReason = "Report left bounded browser retention; persisted run history remains available.";
    }
    job.view.report = snapshot(report);
    job.view.reportRetained = true;
    job.reportBytes = bytes;
  }

  #prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, job] of this.#jobs) if (job.settledAt && job.settledAt < cutoff) this.#jobs.delete(id);
    for (const [id, fix] of this.#fixes) if (!fix.view.activeWorkflowId && Date.parse(fix.view.updatedAt) < cutoff) this.#fixes.delete(id);
  }
}
