import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, type NativeRuntime } from "@0/core";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, type SecurityWorkflow, type SecurityWorkflowExecution, type SecurityWorkflowInput } from "@0/shared";
import type { RunOptions, RunOutcome } from "../commands/run.js";
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
});

describe("manual security workflow execution", () => {
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
    expect((await reopened.handle(`/api/console/workflow-executions/${id}`, "GET", undefined, new URLSearchParams("sessionId=other")))?.status).toBe(404);
  });
});
