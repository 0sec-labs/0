import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowService, LlmApiRuntime, type NativeRuntime } from "@0/engine";
import { SecurityWorkflowStore } from "@0/engine/storage";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, createSecurityWorkflowTemplate, type SecurityWorkflow, type SecurityWorkflowExecution, type SecurityWorkflowInput, type ScanReport } from "@0/engine/shared";
import type { RunOptions, RunOutcome } from "../commands/run.js";
import { WebSentinelService } from "./sentinels.js";
import { WebWorkflowService, type WebWorkflowExecutionContext } from "./workflows.js";

const { runner } = vi.hoisted(() => ({ runner: vi.fn() }));
vi.mock("../commands/run.js", () => ({ runUnified: runner }));
const services: WebWorkflowService[] = [];
const directories: string[] = [];
let count = 0;
const context: WebWorkflowExecutionContext = {
  runtime: {} as NativeRuntime, model: "synthetic-model", providerId: "synthetic", target: "https://example.test",
  status: "ready", autonomyMode: "standard", scopeEnforcement: { pluginId: "scope", enabled: false, projectPath: "/fixture", message: "Fixture" },
};
function service(path = ":memory:", overrides: Partial<WebWorkflowExecutionContext> = {}) {
  const authorize = vi.fn(async () => ({ ...context, ...overrides }));
  const instance = new WebWorkflowService({ dbPath: path, gateway: { getExecutionContext: async () => ({ ...context, ...overrides }), authorizeWorkflowTarget: authorize } });
  services.push(instance);
  return { instance, authorize };
}
const definition: SecurityWorkflowInput = {
  name: "Repository assessment", instructions: "", target: "https://example.test",
  nodes: [
    { id: "start", type: "trigger", label: "Manual start", enabled: true },
    { id: "first", type: "audit", label: "First audit", enabled: true, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN } },
    { id: "optional", type: "audit", label: "Optional audit", enabled: false, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN } },
    { id: "last", type: "audit", label: "Last audit", enabled: true, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN } },
    { id: "report", type: "report", label: "Report", enabled: true },
  ],
  edges: [{ source: "start", target: "first" }, { source: "first", target: "optional" }, { source: "optional", target: "last" }, { source: "last", target: "report" }],
};
async function save(instance: WebWorkflowService) {
  const result = await instance.handle("/api/console/workflow-definitions", "POST", definition, new URLSearchParams());
  expect(result?.status).toBe(201);
  return (result?.data as { definition: SecurityWorkflow }).definition;
}
async function run(instance: WebWorkflowService, workflow: SecurityWorkflow, sessionId = "owner") {
  return instance.handle(`/api/console/workflow-definitions/${workflow.id}/run`, "POST", { sessionId, revision: workflow.revision, approval: "launch-authorized-run" }, new URLSearchParams());
}
async function finished(instance: WebWorkflowService, executionId: string): Promise<SecurityWorkflowExecution> {
  let execution: SecurityWorkflowExecution;
  await vi.waitFor(async () => {
    const result = await instance.handle(`/api/console/workflow-executions/${executionId}`, "GET", undefined, new URLSearchParams("sessionId=owner"));
    execution = (result?.data as { execution: SecurityWorkflowExecution }).execution;
    expect(["completed", "failed", "cancelled"]).toContain(execution.status);
  });
  return execution!;
}
beforeEach(() => {
  count = 0;
  runner.mockReset();
  runner.mockImplementation(async (options: RunOptions) => {
    const scanId = `fixture-scan-${++count}`;
    options.onEvent?.({ type: "scan_started", data: { scanId, persisted: true } });
    options.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome);
  });
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(instance => instance.dispose()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("manual security workflow execution", () => {
  it.each(["workflow deadline", "step deadline", "operator cancellation"] as const)("preserves %s through owned assessment signals and retained partial diagnostics", async mode => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    let childReason: unknown;
    let retainedReport: ScanReport | undefined;
    runner.mockImplementationOnce(async (options: RunOptions) => {
      options.onEvent?.({ type: "scan_started", data: { scanId: "interrupted-assessment", persisted: true } });
      const interrupted = Promise.withResolvers<void>();
      const abort = () => { childReason = options.signal!.reason; interrupted.resolve(); };
      options.signal!.addEventListener("abort", abort, { once: true });
      if (options.signal!.aborted) abort();
      started.resolve();
      try { await interrupted.promise; }
      finally { options.signal!.removeEventListener("abort", abort); }
      const error = childReason instanceof Error ? childReason.message : String(childReason);
      // Synthetic scanner retains partial evidence using its actual signal's
      // cause, matching the assessment/scan-plan interruption contract.
      retainedReport = {
        target: "https://example.test", scanDepth: "default", startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), durationMs: 10,
        summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        findings: [{ id: "partial-evidence", severity: "high", title: "Retained partial evidence", templateId: "fixture", category: "other", description: "Synthetic evidence", status: "discovered", evidence: { request: "Fixture request", response: "Fixture response" }, timestamp: Date.now() }],
        executionSuccessful: false, exitReason: "cancelled", error,
        warnings: [{ stage: "report", message: `Scan interrupted: ${error}. Findings are partial.` }],
      } as ScanReport;
      options.onReport?.(retainedReport);
      options.onOutcome?.({ attempts: [{ status: "cancelled", error }], exit_reason: "cancelled", error } as RunOutcome);
    });
    const { instance } = service();
    try {
      const draft = await instance.handle("/api/console/workflow-definitions", "POST", {
        ...definition,
        nodes: definition.nodes.map(node => node.id === "first" ? {
          ...node, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN, timeCapMs: mode === "step deadline" ? 50 : 10_000 },
        } : node),
      }, new URLSearchParams());
      const workflow = (draft!.data as { definition: SecurityWorkflow }).definition;
      const launched = await instance.invokeLifecycle("owner", "start_run", {
        workflowId: workflow.id, revision: workflow.revision,
        timeCapMs: mode === "workflow deadline" ? 100 : 10_000, costCapUsd: 1,
      }) as { runId: string };
      await started.promise;
      if (mode === "operator cancellation") await instance.invokeLifecycle("owner", "cancel_run", { runId: launched.runId });
      else await vi.advanceTimersByTimeAsync(mode === "step deadline" ? 50 : 100);
      const execution = await finished(instance, launched.runId);
      const expected = mode === "workflow deadline" ? "Workflow deadline exceeded."
        : mode === "step deadline" ? "Workflow step deadline exceeded." : "Operator cancelled this owned workflow.";
      expect(childReason).toBeInstanceOf(Error);
      expect((childReason as Error).message).toBe(expected);
      expect(execution.status).toBe(mode === "operator cancellation" ? "cancelled" : "failed");
      expect(execution.error).toBe(expected);
      expect(execution.nodeResults.first.error).toBe(expected);
      const child = await instance.handle(`/api/console/workflows/${execution.nodeResults.first.jobId}`, "GET", undefined, new URLSearchParams("sessionId=owner"));
      expect(child?.data).toMatchObject({ workflow: { status: "cancelled", error: expected, outcome: { error: expected, attempts: [{ error: expected }] } } });
      const results = await instance.invokeLifecycle("owner", "get_run_results", { runId: launched.runId }) as { findings: Array<{ id: string }>; reports: ScanReport[]; report: ScanReport; error: string };
      expect(results.error).toBe(expected);
      expect(results.findings).toMatchObject([{ id: "partial-evidence" }]);
      expect(results.reports[0]!.error).toBe(expected);
      expect(results.report.warnings).toEqual(retainedReport!.warnings);
      expect(instance.retainedScanReport("interrupted-assessment")).toEqual(retainedReport);
      expect(runner).toHaveBeenCalledTimes(1);
      if (mode !== "operator cancellation") expect(JSON.stringify({ child: child?.data, results })).not.toContain("Operator cancelled");
    } finally {
      try { await instance.dispose(); }
      finally { services.splice(services.indexOf(instance), 1); vi.useRealTimers(); }
    }
  });

  it("keeps Sentinel ownership on PATCH unless it is explicitly cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zero-owned-patch-"));
    directories.push(dir);
    const dbPath = join(dir, "control.db");
    const sentinels = new WebSentinelService({ dbPath, missions: { create: () => ({ id: "m1" }), send: async () => ({}), pendingDecisions: () => 0 } });
    const sentinel = ((await sentinels.handle("/api/console/sentinels", "POST", { preset: "pen-tester" }, new URLSearchParams()))!.data as { sentinel: { id: string } }).sentinel;
    const { instance } = service(dbPath);
    const created = await instance.handle("/api/console/workflow-definitions", "POST", { ...definition, ownerSentinelId: sentinel.id, runIn: "sentinel-home" }, new URLSearchParams());
    expect(created?.status, JSON.stringify(created?.data)).toBe(201);
    const owned = (created?.data as { definition: SecurityWorkflow }).definition;
    const path = `/api/console/workflow-definitions/${owned.id}`;
    const patched = await instance.handle(path, "PATCH", { ...definition, id: owned.id, revision: owned.revision, name: "Renamed" }, new URLSearchParams());
    const kept = (patched?.data as { definition: SecurityWorkflow }).definition;
    expect(kept).toMatchObject({ name: "Renamed", ownerSentinelId: sentinel.id, runIn: "sentinel-home" });
    const detached = await instance.handle(path, "PATCH", { ...definition, id: owned.id, revision: kept.revision, ownerSentinelId: null }, new URLSearchParams());
    expect((detached?.data as { definition: SecurityWorkflow }).definition.ownerSentinelId ?? null).toBeNull();
  });

  it("retains exact scan reports and owned evidence when result persistence fails", async () => {
    const persistence = vi.spyOn(SecurityWorkflowStore.prototype, "saveExecutionResults").mockImplementation(() => { throw new Error("Storage full."); });
    const report = { target: "https://example.test", scanDepth: "default", startedAt: "2026-01-01", completedAt: "2026-01-01", durationMs: 10,
      summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 }, findings: [{ id: "retained-evidence", severity: "high", title: "Evidence", templateId: "fixture", category: "other", description: "Retained original evidence", status: "discovered", evidence: { request: "Fixture request", response: "Retained response" }, timestamp: Date.now() }], warnings: [{ stage: "report", message: "Original warning" }] } as ScanReport;
    runner.mockImplementationOnce(async (options: RunOptions) => {
      options.onEvent?.({ type: "scan_started", data: { scanId: "exact-scan", persisted: true } });
      options.onReport?.(report);
      options.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome);
    });
    const { instance } = service();
    const draft = await instance.handle("/api/console/workflow-definitions", "POST", { ...definition, nodes: definition.nodes.map(node => node.id === "last" ? { ...node, enabled: false } : node) }, new URLSearchParams());
    const launched = await run(instance, (draft?.data as { definition: SecurityWorkflow }).definition);
    const executionId = (launched?.data as { execution: SecurityWorkflowExecution }).execution.id;
    await finished(instance, executionId);
    expect(persistence).toHaveBeenCalled();
    expect(await instance.invokeLifecycle("owner", "get_run_results", { runId: executionId })).toMatchObject({ retained: false, pending: false, findings: [{ id: "retained-evidence" }], report: { warnings: report.warnings } });
    await expect(instance.invokeLifecycle("other", "get_run_results", { runId: executionId })).rejects.toThrow("not found");
    expect(instance.retainedScanReport("exact-scan")).toEqual(report);
    expect(instance.retainedScanReport("other-scan")).toBeUndefined();
  });
  it("owns graph runs in the shared lifecycle and exposes durable engine projections", async () => {
    const started = vi.spyOn(WorkflowService.prototype, "start");
    const waited = vi.spyOn(WorkflowService.prototype, "wait");
    const { instance } = service();
    const launched = await run(instance, await save(instance));
    const id = (launched?.data as { execution: SecurityWorkflowExecution }).execution.id;
    const execution = await finished(instance, id);
    expect(started).toHaveBeenCalledWith("owner", expect.objectContaining({ workflow: expect.objectContaining({ name: definition.name }) }), { id });
    expect(waited).toHaveBeenCalledWith("owner", id);
    expect(instance.getExecution(id)).toEqual(execution);
    expect(instance.listExecutions()).toEqual([execution]);
    expect(instance.runEvents(id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "state", data: { status: "completed" } })]));
    expect(await instance.invokeLifecycle("owner", "list_runs", {})).toEqual({ runs: [execution] });
    expect(await instance.invokeLifecycle("other", "list_runs", {})).toEqual({ runs: [] });
  });

  it("waits for shared graph cancellation cleanup before disposing the browser adapter", async () => {
    const aborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    runner.mockImplementationOnce(async (options: RunOptions) => {
      options.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      await cleanup.promise;
      throw options.signal!.reason;
    });
    const cancelled = vi.spyOn(WorkflowService.prototype, "cancel");
    const { instance } = service();
    const launched = await run(instance, await save(instance));
    const id = (launched?.data as { execution: SecurityWorkflowExecution }).execution.id;
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    let disposed = false;
    const disposal = instance.dispose().then(() => { disposed = true; });
    await aborted.promise;
    expect(disposed).toBe(false);
    expect(cancelled).toHaveBeenCalledWith("owner", id);
    cleanup.resolve();
    await disposal;
    services.splice(services.indexOf(instance), 1);
    expect(disposed).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("launches assessment shortcuts through an inline owned graph without saving a draft", async () => {
    const { instance, authorize } = service();
    const execution = await instance.launchAssessment("owner", { target: "https://example.test", plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN, runCount: 1 } });
    expect(execution.sessionId).toBe("owner");
    expect((await finished(instance, execution.id)).status).toBe("completed");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect((await instance.handle("/api/console/workflow-definitions", "GET", undefined, new URLSearchParams()))?.data).toEqual({ definitions: [] });
    expect(instance.listExecutions()[0].id).toBe(execution.id);
  });

  it("skips disabled audit nodes, executes enabled nodes through authorization, and persists scan links", async () => {
    const { instance, authorize } = service();
    const workflow = await save(instance);
    const result = await run(instance, workflow);
    expect(result?.status).toBe(202);
    const execution = await finished(instance, (result?.data as { execution: SecurityWorkflowExecution }).execution.id);
    expect(execution.status).toBe("completed");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(execution.nodeResults.optional.status).toBe("skipped");
    expect(execution.nodeResults.first.scanIds).toEqual(["fixture-scan-1"]);
    expect(execution.nodeResults.last.scanIds).toEqual(["fixture-scan-2"]);
    expect(execution.workflowRevision).toBe(1);
  });

  it("shares the workflow ledger, passes preceding evidence, and retains collected findings", async () => {
    const report = (id: string): ScanReport => ({
      target: "https://example.test", scanDepth: "default", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 10,
      summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      findings: [{ id, templateId: "fixture", title: `Finding ${id}`, category: "missing-validation", description: "Untrusted assessment evidence", severity: "high", status: "verified", evidence: { request: "fixture request", response: "fixture response" }, timestamp: Date.now() }], warnings: [],
    });
    runner.mockImplementation(async (options: RunOptions) => {
      const id = `evidence-${++count}`;
      options.onReport?.(report(id));
      options.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed", exitCode: 1 } as unknown as RunOutcome);
    });
    const { instance } = service();
    const launched = await run(instance, await save(instance));
    const { execution, workflow } = launched?.data as { execution: SecurityWorkflowExecution; workflow: { id: string } };
    expect((await finished(instance, execution.id)).status).toBe("completed");
    const first = runner.mock.calls[0][0] as RunOptions;
    const second = runner.mock.calls[1][0] as RunOptions;
    expect(first.costLedger).toBeDefined();
    expect(second.costLedger).toBe(first.costLedger);
    expect(first.priorFindings).toEqual([]);
    expect(second.priorFindings).toEqual([expect.objectContaining({ id: "evidence-1", title: "Finding evidence-1" })]);
    const storedResults = await instance.handle(`/api/console/workflow-executions/${execution.id}/results`, "GET", undefined, new URLSearchParams("sessionId=owner"));
    expect(storedResults?.data).toMatchObject({ results: { status: "completed", findings: [{ id: "evidence-1" }, { id: "evidence-2" }] } });
    expect((await instance.handle(`/api/console/workflow-executions/${execution.id}/results`, "GET", undefined, new URLSearchParams("sessionId=other")))?.status).toBe(404);
    const retained = await instance.handle(`/api/console/workflows/${workflow.id}`, "GET", undefined, new URLSearchParams("sessionId=owner"));
    expect(retained?.data).toMatchObject({ workflow: { status: "completed", reportRetained: true, report: { summary: { high: 2, totalFindings: 2 }, findings: [{ id: "evidence-1" }, { id: "evidence-2" }] } } });
  });

  it("stops dependent work after a failed audit and preserves failure history", async () => {
    runner.mockImplementationOnce(async () => { throw new Error("Synthetic audit failure"); });
    const { instance } = service();
    const result = await run(instance, await save(instance));
    const execution = await finished(instance, (result?.data as { execution: SecurityWorkflowExecution }).execution.id);
    expect(execution.status).toBe("failed");
    expect(execution.nodeResults.first.status).toBe("failed");
    expect(execution.nodeResults.last.status).toBe("blocked");
    expect(execution.nodeResults.report.status).toBe("blocked");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects an incompatible pinned template before creating or authorizing a run", async () => {
    const { instance, authorize } = service();
    const draft = createSecurityWorkflowTemplate("repository-review", { target: "https://example.test" });
    const saved = await instance.handle("/api/console/workflow-definitions", "POST", draft, new URLSearchParams());
    expect(saved?.status).toBe(201);
    const workflow = (saved?.data as { definition: SecurityWorkflow }).definition;
    const rejected = await run(instance, workflow);
    expect(rejected?.status).toBe(400);
    expect(rejected?.data).toMatchObject({ error: expect.stringContaining("does not support target type url") });
    expect(authorize).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect((await instance.handle(`/api/console/workflow-definitions/${workflow.id}/executions`, "GET", undefined, new URLSearchParams()))?.data).toEqual({ executions: [] });
  });

  it("rejects stale reviewed revisions and recon mode before dispatch", async () => {
    const { instance } = service();
    const workflow = await save(instance);
    expect((await run(instance, { ...workflow, revision: 2 }))?.status).toBe(409);
    const readonlyService = service(":memory:", { autonomyMode: "recon" }).instance;
    expect((await run(readonlyService, await save(readonlyService)))?.status).toBe(403);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects disabled manual triggers and graphs without an enabled audit", async () => {
    const { instance } = service();
    const disabledTrigger = { ...definition, nodes: definition.nodes.map(node => node.type === "trigger" ? { ...node, enabled: false } : node) };
    expect((await instance.handle("/api/console/workflow-definitions", "POST", disabledTrigger, new URLSearchParams()))?.status).toBe(400);
    const disabledAudits = { ...definition, nodes: definition.nodes.map(node => node.type === "audit" ? { ...node, enabled: false } : node) };
    const saved = await instance.handle("/api/console/workflow-definitions", "POST", disabledAudits, new URLSearchParams());
    expect((await run(instance, (saved?.data as { definition: SecurityWorkflow }).definition))?.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a changed account even when the provider and model return to the same selection", async () => {
    const runtime = new LlmApiRuntime({ type: "api", timeout: 300_000, provider: "openai", model: "gpt-6.1-sol", env: { OPENAI_API_KEY: "synthetic-first-account", ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "" } });
    const { instance } = service(":memory:", { runtime, providerId: "openai", model: "gpt-6.1-sol" });
    runner.mockImplementationOnce(async (options: RunOptions) => {
      options.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome);
      runtime.reconfigure({ provider: "deepseek", model: "deepseek-chat", env: { DEEPSEEK_API_KEY: "synthetic-route", ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "" } });
      runtime.reconfigure({ provider: "openai", model: "gpt-6.1-sol", env: { OPENAI_API_KEY: "synthetic-second-account", ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "" } });
    });
    const result = await run(instance, await save(instance));
    const execution = await finished(instance, (result?.data as { execution: SecurityWorkflowExecution }).execution.id);
    expect(execution.status).toBe("failed");
    expect(execution.error).toContain("connection changed");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("cancels only the owning execution and aborts its active audit before downstream work", async () => {
    runner.mockImplementationOnce(async (options: RunOptions) => {
      const interrupted = Promise.withResolvers<void>();
      options.signal?.addEventListener("abort", () => interrupted.reject(options.signal?.reason), { once: true });
      await interrupted.promise;
    });
    const { instance } = service();
    const result = await run(instance, await save(instance));
    const id = (result?.data as { execution: SecurityWorkflowExecution }).execution.id;
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect((await instance.handle(`/api/console/workflow-executions/${id}/cancel`, "POST", { sessionId: "other" }, new URLSearchParams()))?.status).toBe(404);
    expect((await instance.handle(`/api/console/workflow-executions/${id}/cancel`, "POST", { sessionId: "owner" }, new URLSearchParams()))?.status).toBe(200);
    const execution = await finished(instance, id);
    expect(execution.status).toBe("cancelled");
    expect(execution.nodeResults.first.status).toBe("cancelled");
    expect(execution.nodeResults.last.status).toBe("cancelled");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("retains completed immutable definitions and execution history after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zero-workflow-history-")); directories.push(directory);
    const path = join(directory, "control.db");
    const { instance } = service(path);
    const workflow = await save(instance);
    const result = await run(instance, workflow);
    const id = (result?.data as { execution: SecurityWorkflowExecution }).execution.id;
    await finished(instance, id);
    await instance.dispose(); services.splice(services.indexOf(instance), 1);
    const reopened = service(path).instance;
    const history = await reopened.handle(`/api/console/workflow-definitions/${workflow.id}/executions`, "GET", undefined, new URLSearchParams());
    const executions = (history?.data as { executions: SecurityWorkflowExecution[] }).executions;
    expect(executions[0]).toMatchObject({ id, status: "completed", workflowRevision: 1, workflow: { name: definition.name } });
    expect((await reopened.handle(`/api/console/workflow-executions/${id}/results`, "GET", undefined, new URLSearchParams("sessionId=owner")))?.data).toMatchObject({ results: { status: "completed", reports: [], findings: [] } });
    expect((await reopened.handle(`/api/console/workflow-executions/${id}`, "GET", undefined, new URLSearchParams("sessionId=other")))?.status).toBe(404);
  });
});

describe("browser workflow lifecycle", () => {
  it("starts a template snapshot without saving a draft and returns owner-scoped results", async () => {
    const { instance } = service(":memory:", { runtime: { type: "api", executeNative: vi.fn(), isAvailable: async () => true } as NativeRuntime });
    const launched = await instance.invokeLifecycle("owner", "start_run", { templateId: "api-security", target: "https://example.test", idempotencyKey: "same-request" }) as { runId: string };
    const replayed = await instance.invokeLifecycle("owner", "start_run", { templateId: "api-security", target: "https://example.test", idempotencyKey: "same-request" }) as { runId: string };
    expect(replayed.runId).toBe(launched.runId);
    await finished(instance, launched.runId);
    expect(await instance.invokeLifecycle("owner", "list_workflows", {})).toEqual({ workflows: [] });
    expect(await instance.invokeLifecycle("owner", "get_run", { runId: launched.runId })).toMatchObject({ run: { id: launched.runId, status: "completed" } });
    expect(await instance.invokeLifecycle("owner", "get_run_results", { runId: launched.runId })).toMatchObject({ runId: launched.runId, status: "completed", findings: [] });
    await expect(instance.invokeLifecycle("other", "get_run", { runId: launched.runId })).rejects.toThrow("for this session");
    await expect(instance.invokeLifecycle("owner", "start_run", { templateId: "api-security", target: "https://changed.test", idempotencyKey: "same-request" })).rejects.toThrow("different run inputs");
  });

  it("runs typed mobile research through the common runner with canonical target and retained native output", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-browser-research-")); directories.push(root);
    const { instance, authorize } = service();
    const saved = await instance.handle("/api/console/workflow-definitions", "POST", {
      name: "Mobile intake", instructions: "", target: `source:${root}`,
      nodes: [{ id: "start", type: "trigger", label: "Start", enabled: true }, { id: "mobile", type: "research", label: "Mobile intake", enabled: true, inputs: { engine: "mobile" } }],
      edges: [{ source: "start", target: "mobile" }],
    }, new URLSearchParams());
    expect(saved?.status).toBe(201);
    const workflow = (saved?.data as { definition: SecurityWorkflow }).definition;
    const started = await instance.invokeLifecycle("owner", "start_run", { workflowId: workflow.id, revision: workflow.revision }) as { runId: string };
    expect((await finished(instance, started.runId)).status).toBe("completed");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(runner).not.toHaveBeenCalled();
    expect(await instance.invokeLifecycle("owner", "get_run_results", { runId: started.runId })).toMatchObject({ outputs: [{ outputs: [{ kind: "research", value: { completed: true, findings: [] } }] }] });
  });

  it("requires host capability in addition to an application request", async () => {
    const { instance } = service();
    await expect(instance.invokeLifecycle("owner", "start_run", { templateId: "fix-candidate", target: "/fixture", allowApply: true })).rejects.toThrow("host approval");
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("persisted assessment resume", () => {
  function persisted(target = "https://example.test") {
    const directory = mkdtempSync(join(tmpdir(), "web-resume-")); directories.push(directory);
    const path = join(directory, "engine.db");
    return { path, target };
  }
  async function scanFixture(target = "https://example.test", mode: "deep" | "web" = "deep") {
    const paths = persisted(target);
    const { osecDB } = await import("@0/engine/storage");
    const db = new osecDB(paths.path);
    db.createScan({ target, depth: "deep", format: "json", mode, runtime: "api" }, "prior-scan");
    db.close();
    return paths;
  }
  const approved = { sessionId: "owner", approval: "launch-authorized-run" };
  it("routes persisted scan state through current approvals and model, without replay", async () => {
    const paths = await scanFixture("web:https://example.test", "web");
    const { instance, authorize } = service(paths.path);
    const launched = await instance.resumeScan("prior-scan", { ...approved, branchFromEntry: 0, timeCapMs: 2000, costCapUsd: 1 });
    expect(launched.status).toBe(202);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    expect(authorize).toHaveBeenCalledWith("owner", { target: "https://example.test", kind: "web" }, expect.any(AbortSignal), expect.any(String), { interactive: true });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ resumeScanId: "prior-scan", branchFromEntry: 0, target: "https://example.test", targetType: "web-app", mode: "web", depth: "deep", model: "synthetic-model", dbPath: paths.path, plan: expect.objectContaining({ runCount: 1, executionMode: "sequential", timeCapMs: 2000, costCapUsd: 1 }) }));
    expect(runner.mock.calls[0]![0]).not.toHaveProperty("messages");
  });
  it("does not resume imported CI evidence or authorize a workflow from it", async () => {
    const paths = persisted("repo:/ci/checkout");
    const { importCiReport } = await import("../report-import.js");
    const result = importCiReport({ dbPath: paths.path, reportJson: JSON.stringify({ target: paths.target, scanDepth: "quick", startedAt: "2026-11-13T10:00:00Z", completedAt: "2026-11-13T10:01:00Z", durationMs: 60000, findings: [], warnings: [], executionSuccessful: true }) });
    const { instance, authorize } = service(paths.path);
    const reply = await instance.resumeScan(result.scanId, approved);
    expect(reply.status).toBe(400);
    expect(reply.data).toMatchObject({ error: expect.stringContaining("not resumable") });
    expect(authorize).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
  });
  it("rejects caller authority overrides, missing scans and conversations before launch", async () => {
    const paths = await scanFixture();
    const { instance, authorize } = service(paths.path);
    expect((await instance.resumeScan("prior-scan", { ...approved, target: "/other" })).status).toBe(400);
    expect((await instance.resumeScan("missing", approved)).status).toBe(404);
    expect((await instance.resumeScan("prior-scan", { ...approved, branchFromEntry: -1 })).status).toBe(400);
    expect(authorize).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
  });
  it("authorizes source scope before branching or running", async () => {
    const paths = await scanFixture("repo:/outside/source");
    const { instance, authorize } = service(paths.path);
    authorize.mockRejectedValue(new Error("Source target is outside approved scope."));
    const result = await instance.resumeScan("prior-scan", { ...approved, branchFromEntry: 2 });
    expect(result.status).toBe(202);
    await vi.waitFor(async () => {
      const id = (result.data as { workflow: { id: string } }).workflow.id;
      const job = await instance.handle(`/api/console/workflows/${id}`, "GET", undefined, new URLSearchParams("sessionId=owner"));
      expect((job?.data as { workflow: { status: string } }).workflow.status).toBe("failed");
    });
    expect(runner).not.toHaveBeenCalled();
  });
  it("blocks concurrent resumes of the same persisted scan", async () => {
    const paths = await scanFixture();
    const { instance } = service(paths.path);
    const cleanup = Promise.withResolvers<void>();
    runner.mockImplementationOnce(async (options: RunOptions) => {
      await cleanup.promise;
      options.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome);
    });
    const [first, second] = await Promise.all([instance.resumeScan("prior-scan", approved), instance.resumeScan("prior-scan", approved)]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    cleanup.resolve();
  });
  it("keeps canonical local source boundaries before journal branch mutation", async () => {
    const outside = mkdtempSync(join(tmpdir(), "resume-outside-")); directories.push(outside);
    const approvedRoot = mkdtempSync(join(tmpdir(), "resume-approved-")); directories.push(approvedRoot);
    const paths = await scanFixture(`repo:${outside}`);
    const { instance } = service(paths.path, { localScopePath: approvedRoot, scopeEnforcement: { ...context.scopeEnforcement, enabled: true } });
    const result = await instance.resumeScan("prior-scan", { ...approved, branchFromEntry: 2 });
    const id = (result.data as { workflow: { id: string } }).workflow.id;
    await vi.waitFor(async () => {
      const job = await instance.handle(`/api/console/workflows/${id}`, "GET", undefined, new URLSearchParams("sessionId=owner"));
      expect((job?.data as { workflow: { status: string; error?: string } }).workflow).toMatchObject({ status: "failed", error: expect.stringContaining("outside the explicitly approved local scope") });
    });
    expect(runner).not.toHaveBeenCalled();
  });
});
