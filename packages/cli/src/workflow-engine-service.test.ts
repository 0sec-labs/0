import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntime } from "@0/core";
import type { SecurityWorkflowExecution, ScanReport } from "@0/shared";
import type { RunOptions, RunOutcome } from "./commands/run.js";
import { WorkflowEngineService } from "./workflow-engine-service.js";
import { ConsoleGateway, type ConsoleExecutionContext } from "./web/console-gateway.js";
import { WebWorkflowService } from "./web/workflows.js";

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
const gates: Array<() => void> = [];
afterEach(async () => { gates.splice(0).forEach(release => release()); for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function report(target: string): ScanReport { return { target, scanDepth: "quick", startedAt: "2026-01-01", completedAt: "2026-01-01", durationMs: 1, findings: [], warnings: [], summary: { totalAttacks: 1, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 } }; }
async function fixture(assessment?: (request: RunOptions) => Promise<void>, options: { timeCapMs?: number; costCapUsd?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "0-engine-host-")); roots.push(root); const workspace = join(root, "repo"); mkdirSync(workspace); const outside = join(root, "outside"); mkdirSync(outside);
  const gateway = new ConsoleGateway({ projectPath: workspace, dbPath: join(root, "history.db"), homeDir: root });
  const context = { runtime: { type: "api", isAvailable: async () => true, executeNative: vi.fn() } as unknown as NativeRuntime, model: "fixture", providerId: "fixture", target: workspace, status: "ready", autonomyMode: "standard", role: "audit", scopeEnforcement: { pluginId: "scope", enabled: false, projectPath: workspace, message: "Fixture" } } as ConsoleExecutionContext;
  vi.spyOn(gateway, "getExecutionContext").mockResolvedValue(context); vi.spyOn(gateway, "authorizeWorkflowTarget").mockResolvedValue(context);
  const runner = vi.fn(assessment ?? (async request => { request.onReport?.(report(request.target)); request.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome); }));
  const workflows = new WebWorkflowService({ gateway, dbPath: join(root, "history.db"), runAssessment: runner });
  const service = new WorkflowEngineService({ token: "x".repeat(32), workspace, ...options }, { gateway, workflows });
  cleanup.push(async () => { await workflows.dispose(); await gateway.closeAll(); }); cleanup.push(() => service.dispose());
  await service.ready; return { service, gateway, workflows, workspace, outside, runner };
}
describe("workflow facade uses the existing browser engine", () => {
  it("starts, inspects and cancels the same browser-session run without owning host disposal", async () => {
    const gate = Promise.withResolvers<void>(); gates.push(gate.resolve); const entered = Promise.withResolvers<void>();
    const f = await fixture(async request => { entered.resolve(); await gate.promise; request.onReport?.(report(request.target)); });
    const browser = f.gateway.create({ target: f.workspace });
    const run = await f.service.invoke("start_run", { sessionId: browser.id, templateId: "repository-review", target: f.workspace }) as SecurityWorkflowExecution;
    await entered.promise;
    expect(f.workflows.getExecution(run.id)?.sessionId).toBe(browser.id);
    expect(await f.service.invoke("get_run", { runId: run.id })).toMatchObject({ id: run.id, sessionId: browser.id, status: "running" });
    expect(await f.service.invoke("cancel_run", { runId: run.id })).toMatchObject({ id: run.id, status: "running", cancellationRequested: true });
    const browserProjection = await f.workflows.handle(`/api/console/workflow-executions/${run.id}`, "GET", undefined, new URLSearchParams({ sessionId: browser.id }));
    expect(browserProjection?.data).toMatchObject({ execution: { id: run.id, cancellationRequested: true, cancellationAcknowledged: true, cancellationRequestedAt: expect.any(String) } });
    gate.resolve(); await vi.waitFor(() => expect(f.workflows.getExecution(run.id)?.status).toBe("cancelled"));
    const close = vi.spyOn(f.gateway, "closeAll"); const dispose = vi.spyOn(f.workflows, "dispose"); await f.service.dispose();
    expect(close).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); expect(f.gateway.get(browser.id).session.id).toBe(browser.id);
    await expect(f.service.invoke("list_runs", {})).rejects.toThrow("closed");
  });
  it("rejects forged authority, invalid limits and outside workspace before session allocation", async () => {
    const f = await fixture(); const create = vi.spyOn(f.gateway, "create");
    for (const extra of [{ ownerId: "forged" }, { workspace: "/other" }, { scopePath: "/other" }, { model: "caller" }, { timeCapMs: "12" }, { costCapUsd: Infinity }, { allowApply: true }]) await expect(f.service.invoke("start_run", { templateId: "repository-review", target: f.workspace, ...extra })).rejects.toThrow();
    await expect(f.service.invoke("start_run", { templateId: "repository-review", target: f.outside })).rejects.toThrow("outside");
    expect(create).not.toHaveBeenCalled(); expect(f.runner).not.toHaveBeenCalled(); expect(f.workflows.listExecutions()).toEqual([]);
  });
  it("clamps valid run limits to configured ceilings and exposes session event shapes", async () => {
    const f = await fixture(undefined, { timeCapMs: 1000, costCapUsd: 0.1 }); const session = f.gateway.create({ target: f.workspace });
    const run = await f.service.invoke("start_run", { sessionId: session.id, templateId: "repository-review", target: f.workspace, timeCapMs: 2000, costCapUsd: 1 }) as SecurityWorkflowExecution;
    await vi.waitFor(() => expect(f.workflows.getExecution(run.id)?.status).toBe("completed"));
    expect(f.runner.mock.calls[0]![0]).toMatchObject({ costCeilingUsd: 0.1 }); expect(f.runner.mock.calls[0]![0].timeout).toBeLessThanOrEqual(1000);
    expect(await f.service.invoke("get_session", { sessionId: session.id })).toMatchObject({ session: { id: session.id }, cursor: expect.any(Number), messages: expect.any(Array) });
    expect(await f.service.invoke("get_session_events", { sessionId: session.id, after: 0 })).toMatchObject({ cursor: expect.any(Number), events: expect.any(Array), gap: expect.any(Boolean) });
    await expect(f.service.invoke("get_run", { runId: run.id, sessionId: "forged" })).rejects.toThrow();
  });
  it("rejects invalid server credentials and ceilings at construction", async () => {
    const f = await fixture();
    for (const options of [{ token: "weak" }, { token: " ".repeat(32) }, { token: "x".repeat(32), timeCapMs: 0 }, { token: "x".repeat(32), costCapUsd: 1001 }]) expect(() => new WorkflowEngineService(options, f)).toThrow();
  });
  it("admits assessment shortcuts through workspace and live scope gates before allocating sessions", async () => {
    const f = await fixture(undefined, { timeCapMs: 1000, costCapUsd: 0.1 });
    const create = vi.spyOn(f.gateway, "create");
    const plan = { goal: "unknown-vulnerabilities", depth: "quick", runCount: 1, executionMode: "sequential", timeCapMs: 2000, costCapUsd: 1 };
    for (const extra of [{ ownerId: "forged" }, { model: "caller-model" }, { workspace: f.outside }, { scopePath: "/scope" }, { plan: { ...plan, costCapUsd: Infinity } }]) {
      await expect(f.service.invoke("start_assessment", { target: f.workspace, plan, ...extra })).rejects.toThrow();
    }
    symlinkSync(f.outside, join(f.workspace, "escape"));
    for (const target of [f.outside, join(f.workspace, "escape")]) await expect(f.service.invoke("start_assessment", { target, plan })).rejects.toThrow("outside");
    await expect(f.service.invoke("start_assessment", { target: "https://unadmitted.example", plan })).rejects.toThrow("configured scope");
    expect(create).not.toHaveBeenCalled(); expect(f.runner).not.toHaveBeenCalled(); expect(f.workflows.listExecutions()).toEqual([]);
    const run = await f.service.invoke("start_assessment", { target: f.workspace, plan }) as SecurityWorkflowExecution;
    await vi.waitFor(() => expect(f.workflows.getExecution(run.id)?.status).toBe("completed"));
    expect(create).toHaveBeenCalledOnce();
    expect(f.gateway.authorizeWorkflowTarget).toHaveBeenCalledWith(run.sessionId, expect.objectContaining({ target: f.workspace, kind: "source" }), expect.anything(), expect.anything(), expect.objectContaining({ interactive: true }));
    expect(f.runner.mock.calls[0]![0]).toMatchObject({ costCeilingUsd: 0.1 }); expect(f.runner.mock.calls[0]![0].timeout).toBeLessThanOrEqual(1000);
    expect(await f.service.invoke("get_capabilities", {})).toMatchObject({ operations: expect.arrayContaining(["start_assessment", "resume_scan"]), resume: { session: true, scan: true, workflow: false } });
  });

  it("clamps validated scan resume limits and rejects malformed budgets before invoking the host", async () => {
    const f = await fixture(undefined, { timeCapMs: 1000, costCapUsd: 0.1 });
    const resume = vi.spyOn(f.workflows, "resumeScan").mockResolvedValue({ status: 202, data: { runId: "resumed" } });
    const base = { sessionId: "existing-session", scanId: "persisted-scan" };
    for (const extra of [{ timeCapMs: "100" }, { costCapUsd: "0.01" }, { costCapUsd: Infinity }, { ownerId: "forged" }, { model: "caller" }]) {
      await expect(f.service.invoke("resume_scan", { ...base, ...extra })).rejects.toThrow();
    }
    expect(resume).not.toHaveBeenCalled();
    await f.service.invoke("resume_scan", { ...base, timeCapMs: 5000, costCapUsd: 1 });
    expect(resume).toHaveBeenLastCalledWith("persisted-scan", { sessionId: "existing-session", timeCapMs: 1000, costCapUsd: 0.1, approval: "launch-authorized-run" });
    await f.service.invoke("resume_scan", base);
    expect(resume).toHaveBeenLastCalledWith("persisted-scan", { sessionId: "existing-session", timeCapMs: 1000, costCapUsd: 0.1, approval: "launch-authorized-run" });
    await f.service.invoke("resume_scan", { ...base, timeCapMs: 500, costCapUsd: 0.01 });
    expect(resume).toHaveBeenLastCalledWith("persisted-scan", { sessionId: "existing-session", timeCapMs: 500, costCapUsd: 0.01, approval: "launch-authorized-run" });
    const defaults = await fixture();
    const defaultResume = vi.spyOn(defaults.workflows, "resumeScan").mockResolvedValue({ status: 202, data: {} });
    await defaults.service.invoke("resume_scan", base);
    expect(defaultResume).toHaveBeenCalledWith("persisted-scan", { sessionId: "existing-session", timeCapMs: 600_000, costCapUsd: 5, approval: "launch-authorized-run" });
  });

});
