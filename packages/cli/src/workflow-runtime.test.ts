import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntime } from "@0/core";
import type { SecurityWorkflow, SecurityWorkflowExecution, ScanReport } from "@0/shared";
import type { RunOptions, RunOutcome } from "./commands/run.js";
import { ConsoleGateway, type ConsoleExecutionContext } from "./web/console-gateway.js";
import { WebWorkflowService } from "./web/workflows.js";
import * as localEngines from "./local-engine.js";
import { SecurityWorkflowStore } from "@0/db";
import { createCliWorkflowRuntime, parseWorkflowRunInputs } from "./workflow-runtime.js";

const directories: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function report(target: string): ScanReport {
  return { target, scanDepth: "quick", startedAt: "2026-01-01", completedAt: "2026-01-01", durationMs: 1, findings: [], warnings: [], summary: { totalAttacks: 1, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 } };
}
async function fixture(runAssessment?: (options: RunOptions) => Promise<void>, options: { timeCapMs?: number; costCapUsd?: number; target?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-shared-host-")); directories.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const gateway = new ConsoleGateway({ projectPath: workspace, dbPath: join(root, "history.db"), homeDir: root });
  const context = {
    runtime: { type: "api", isAvailable: async () => true, executeNative: vi.fn() } as unknown as NativeRuntime,
    model: "fixture", providerId: "fixture", target: workspace, status: "ready", autonomyMode: "standard", role: "audit",
    scopeEnforcement: { pluginId: "scope", enabled: false, projectPath: workspace, message: "Fixture" },
  } as ConsoleExecutionContext;
  vi.spyOn(gateway, "getExecutionContext").mockResolvedValue(context);
  const authorize = vi.spyOn(gateway, "authorizeWorkflowTarget").mockResolvedValue(context);
  const assessment = vi.fn(runAssessment ?? (async (request: RunOptions) => {
    request.onReport?.(report(request.target));
    request.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome);
  }));
  const workflows = new WebWorkflowService({ gateway, dbPath: join(root, "history.db"), runAssessment: assessment });
  gateway.attachWorkflowLifecycle({ invoke: (sessionId, name, args, capabilities) => workflows.invokeLifecycle(sessionId, name, args, capabilities) });
  cleanup.push(async () => { await workflows.dispose(); await gateway.closeAll(); });
  const runtime = await createCliWorkflowRuntime({ ownerId: "cli", workspace, ...options }, { host: { gateway, workflows } });
  cleanup.push(runtime.dispose);
  return { gateway, workflows, runtime, workspace, assessment, authorize };
}
async function settled(runtime: Awaited<ReturnType<typeof createCliWorkflowRuntime>>, id: string) {
  await vi.waitFor(async () => expect(["completed", "failed", "cancelled"]).toContain((await runtime.getRun(id))?.status));
}

describe("embedded workflow transport uses the browser engine host", () => {
  it("validates bounded portable bindings", () => {
    expect(() => parseWorkflowRunInputs({ value: undefined })).toThrow();
    expect(() => parseWorkflowRunInputs({ note: "x".repeat(33_000) })).toThrow();
    expect(() => parseWorkflowRunInputs(JSON.parse('{"__proto__":{}}'))).toThrow();
    expect(parseWorkflowRunInputs({ findingId: "finding-1" })).toEqual({ findingId: "finding-1" });
  });
  it("inspects and cancels a browser-owned run through the same host", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const { runtime, workflows, gateway, workspace, assessment } = await fixture(async request => {
      request.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve(); await aborted.promise; throw request.signal!.reason;
    });
    const session = gateway.create({ target: workspace });
    const started = await workflows.invokeLifecycle(session.id, "start_run", { templateId: "repository-review", target: workspace }) as { runId: string };
    await entered.promise;
    expect(await runtime.getRun(started.runId)).toMatchObject({ id: started.runId, sessionId: session.id, status: "running" });
    expect(await runtime.listRuns()).toEqual(expect.arrayContaining([expect.objectContaining({ id: started.runId })]));
    await runtime.cancelRun(started.runId);
    await aborted.promise;
    await settled(runtime, started.runId);
    expect(workflows.getExecution(started.runId)?.status).toBe("cancelled");
    expect(assessment).toHaveBeenCalledTimes(1);
  });
  it("detaches an injected client without cancelling its running engine work", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const { runtime, workflows, gateway, workspace } = await fixture(async request => {
      entered.resolve(); await finish.promise;
      expect(request.signal?.aborted).toBe(false);
      request.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome);
    });
    const session = gateway.create({ target: workspace });
    const started = await workflows.invokeLifecycle(session.id, "start_run", { templateId: "repository-review", target: workspace }) as { runId: string };
    await entered.promise; await runtime.dispose();
    expect(workflows.getExecution(started.runId)?.status).toBe("running");
    await expect(runtime.listRuns()).rejects.toThrow("shutting down");
    finish.resolve();
    await vi.waitFor(() => expect(workflows.getExecution(started.runId)?.status).toBe("completed"));
  });
  it("shares definitions, approvals, results and idempotent starts with the web service", async () => {
    const { runtime, workflows, gateway, workspace, assessment, authorize } = await fixture();
    const session = gateway.create({ target: workspace });
    const workflow = await runtime.saveWorkflow({ name: "Shared", instructions: "", target: workspace,
      nodes: [{ id: "start", type: "trigger", label: "Start", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }], edges: [{ source: "start", target: "audit" }] }) as SecurityWorkflow;
    const [first, replay] = await Promise.all([1, 2].map(() => runtime.startRun({ sessionId: session.id, workflowId: workflow.id, revision: workflow.revision, target: workspace, idempotencyKey: "retry" })));
    expect(replay.id).toBe(first.id);
    await settled(runtime, first.id);
    expect(assessment).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect((await workflows.invokeLifecycle(session.id, "get_run", { runId: first.id }) as { run: SecurityWorkflowExecution }).run.status).toBe("completed");
    expect(await runtime.getRunResults(first.id)).toMatchObject({ runId: first.id, findings: [] });
    expect(await runtime.getWorkflow(workflow.id)).toMatchObject({ id: workflow.id });
    await expect(runtime.startRun({ sessionId: session.id, workflowId: workflow.id, revision: workflow.revision + 1, target: workspace })).rejects.toThrow();
  });
  it("enforces host ceilings and apply authority before dispatch", async () => {
    const { runtime, gateway, workspace, assessment } = await fixture(undefined, { timeCapMs: 2000, costCapUsd: 2 });
    const session = gateway.create({ target: workspace });
    await expect(runtime.startRun({ sessionId: session.id, templateId: "repository-review", target: workspace, allowApply: true })).rejects.toThrow();
    expect(assessment).not.toHaveBeenCalled();
    const started = await runtime.startRun({ sessionId: session.id, templateId: "repository-review", target: workspace, timeCapMs: 9000, costCapUsd: 9 });
    await settled(runtime, started.id);
    for (const [request] of assessment.mock.calls) {
      expect(request.timeout).toBeLessThanOrEqual(2000);
      expect(request.costCeilingUsd).toBe(2);
    }
  });
  it("automatically attaches before constructing a second host or recovering its history", async () => {
    const { runtime: attached, workspace } = await fixture();
    const discover = vi.spyOn(localEngines, "connectLocalEngine").mockResolvedValue(attached as unknown as NonNullable<Awaited<ReturnType<typeof localEngines.connectLocalEngine>>>);
    const recovery = vi.spyOn(SecurityWorkflowStore.prototype, "interruptActiveExecutions");
    const runtime = await createCliWorkflowRuntime({ ownerId: "cli", workspace });
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ workspace: realpathSync(workspace) }));
    expect(recovery).not.toHaveBeenCalled();
    expect(await runtime.listWorkflows()).toEqual(await attached.listWorkflows());
    await runtime.dispose();
  });
  it("starts a template snapshot without cloning a saved definition", async () => {
    const { runtime, workspace, assessment } = await fixture();
    const started = await runtime.startRun({ templateId: "repository-review", target: workspace });
    await settled(runtime, started.id);
    expect(await runtime.listWorkflows()).toEqual([]);
    expect(assessment).toHaveBeenCalled();
    expect(await runtime.listSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ id: started.sessionId })]));
  });
  it("rejects source paths outside the host grant before allocating history", async () => {
    const { runtime, workspace, assessment } = await fixture();
    await expect(runtime.startRun({ templateId: "repository-review", target: join(workspace, "..") })).rejects.toThrow("outside");
    expect(await runtime.listRuns()).toEqual([]);
    expect(assessment).not.toHaveBeenCalled();
  });
  it("rejects portable model replacement and invalid result pages", async () => {
    const { runtime, workspace, assessment } = await fixture();
    await expect(runtime.startRun({ templateId: "repository-review", target: workspace, model: "caller-replacement" })).rejects.toThrow("embedded engine model");
    expect(assessment).not.toHaveBeenCalled();
    const started = await runtime.startRun({ templateId: "repository-review", target: workspace });
    await settled(runtime, started.id);
    await expect(runtime.getRunResults(started.id, { cursor: -1 })).rejects.toThrow();
    await expect(runtime.getRunResults(started.id, { limit: 101 })).rejects.toThrow();
  });
  it("retains failure history and prevents dependent steps across every transport", async () => {
    const { runtime, workflows, workspace, assessment } = await fixture(async () => { throw new Error("Synthetic engine failure"); });
    const started = await runtime.startRun({ templateId: "repository-review", target: workspace });
    await settled(runtime, started.id);
    expect(await runtime.getRun(started.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Synthetic engine failure") });
    const steps = Object.values(workflows.getExecution(started.id)!.nodeResults);
    expect(steps.some(step => step.status === "failed")).toBe(true);
    expect(steps.some(step => step.status === "blocked")).toBe(true);
    expect(assessment).toHaveBeenCalledTimes(1);
  });
  it("validates workspace and owner configuration before allocating a host", async () => {
    await expect(createCliWorkflowRuntime({ ownerId: "", workspace: "/tmp" })).rejects.toThrow("valid owner");
    await expect(createCliWorkflowRuntime({ ownerId: "cli", workspace: "relative" })).rejects.toThrow("absolute path");
  });
});
