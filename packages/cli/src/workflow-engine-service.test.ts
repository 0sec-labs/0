import { describe, expect, it, vi } from "vitest";
import { WorkflowEngineService } from "./workflow-engine-service.js";
import type { createCliWorkflowRuntime, CliWorkflowRuntimeOptions } from "./workflow-runtime.js";
function setup() {
  const runtime = { listTemplates: vi.fn(() => []), getTemplate: vi.fn(), listWorkflows: vi.fn(() => []), listRuns: vi.fn(() => []),
    getWorkflow: vi.fn(), saveWorkflow: vi.fn(), startRun: vi.fn(async () => ({ id: "run-1", status: "running" })),
    getRun: vi.fn(), getRunResults: vi.fn(), cancelRun: vi.fn(), dispose: vi.fn(async () => {}) };
  const createRuntime = vi.fn(async (_options: CliWorkflowRuntimeOptions) => runtime as unknown as Awaited<ReturnType<typeof createCliWorkflowRuntime>>);
  const service = new WorkflowEngineService({ token: "private-engine-token".repeat(3), workspace: "/engine/repo", scopePath: "/engine/scope.json", allowApply: false }, createRuntime);
  return { runtime, service, createRuntime };
}
describe("persistent workflow engine service", () => {
  it("selects ownership and execution authority on the server and does not recover unrelated shared runs", async () => {
    const f = setup(); await f.service.ready;
    const configured = f.createRuntime.mock.calls[0]![0];
    expect(configured).toMatchObject({ ownerId: expect.stringMatching(/^engine:[a-f0-9]{64}$/), recoverInterrupted: false, workspace: "/engine/repo", scopePath: "/engine/scope.json", allowApply: false, timeCapMs: 600_000, costCapUsd: 5 });
    expect(JSON.stringify(configured)).not.toContain("private-engine-token");
    const args = { templateId: "repository-review", target: "/engine/repo", inputs: { findingId: "finding-1" }, allowApply: false };
    await f.service.invoke("start_run", args);
    expect(f.runtime.startRun).toHaveBeenCalledWith(args);
    expect(f.runtime.dispose).not.toHaveBeenCalled();
    await f.service.invoke("list_runs", {});
    expect(f.runtime.listRuns).toHaveBeenCalledOnce();
    await f.service.dispose();
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });
  it("rejects weak credentials and invalid server ceilings before constructing a runtime", () => {
    const createRuntime = vi.fn();
    for (const options of [{ token: "weak" }, { token: " ".repeat(32) }, { token: "x".repeat(32), timeCapMs: 0 }, { token: "x".repeat(32), costCapUsd: 1001 }]) {
      expect(() => new WorkflowEngineService(options, createRuntime)).toThrow();
    }
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it("retains default ceilings when optional startup flags are undefined", async () => {
    const f = setup();
    const service = new WorkflowEngineService({ token: "x".repeat(32), timeCapMs: undefined, costCapUsd: undefined }, f.createRuntime);
    await service.ready;
    expect(f.createRuntime.mock.calls[1]![0]).toMatchObject({ timeCapMs: 600_000, costCapUsd: 5 });
    await Promise.all([service.dispose(), f.service.dispose()]);
  });
  it("rejects caller authority and model/scope overrides before dispatch", async () => {
    const f = setup(); await f.service.ready;
    for (const overrides of [{ ownerId: "browser-owner" }, { workspace: "/other" }, { scopePath: "/other.json" }, { model: "caller-model" }]) {
      await expect(f.service.invoke("start_run", { templateId: "review", target: "/engine/repo", ...overrides })).rejects.toThrow();
    }
    expect(f.runtime.startRun).not.toHaveBeenCalled();
    await f.service.dispose();
  });
});
