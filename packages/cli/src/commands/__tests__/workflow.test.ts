import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityWorkflowExecution } from "@0/shared";
import { registerWorkflowCommand, runWorkflowCommand, type WorkflowCliRuntime, type WorkflowCommandDeps } from "../workflow.js";

function fixture(status: SecurityWorkflowExecution["status"] = "completed"): SecurityWorkflowExecution {
  return { id: "run-1", status, nodeResults: {} } as SecurityWorkflowExecution;
}
function setup() {
  const runtime: WorkflowCliRuntime = {
    listTemplates: vi.fn(() => [{ id: "repository-review" }]), getTemplate: vi.fn(() => ({ id: "repository-review" })),
    listWorkflows: vi.fn(() => []), getWorkflow: vi.fn(() => ({ id: "saved", target: "/repo", revision: 4 })),
    startRun: vi.fn(() => fixture("running")), getRun: vi.fn(() => fixture()),
    getRunResults: vi.fn(() => ({ findings: [{ severity: "critical", evidence: "code" }] })),
    cancelRun: vi.fn(), dispose: vi.fn(),
  };
  const deps: WorkflowCommandDeps = { createRuntime: vi.fn(async () => runtime), out: vi.fn(), err: vi.fn(), sleep: vi.fn(async () => {}) };
  return { runtime, deps };
}
afterEach(() => { process.exitCode = 0; });
describe("workflow CLI", () => {
  it("remembers cancellation while a remote engine allocates a run", async () => {
    const { runtime, deps } = setup();
    const previous = process.listenerCount("SIGINT");
    vi.mocked(runtime.startRun).mockImplementation(async () => { process.emit("SIGINT"); return fixture("running"); });
    await runWorkflowCommand("saved", {}, deps);
    expect(runtime.cancelRun).toHaveBeenCalledWith("run-1");
    expect(process.listenerCount("SIGINT")).toBe(previous);
  });
  it("runs a template directly and preserves findings without failing completed execution", async () => {
    const { runtime, deps } = setup();
    await runWorkflowCommand(undefined, { template: "repository-review", target: "/repo", workspace: "/repo", scope: "/scope.json", model: "configured", timeCap: "1000", costCap: "2", format: "json" }, deps);
    expect(runtime.startRun).toHaveBeenCalledWith({ templateId: "repository-review", workflowId: undefined, revision: undefined, target: "/repo", model: "configured", timeCapMs: 1000, costCapUsd: 2 });
    expect(deps.createRuntime).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "cli", workspace: "/repo", scopePath: "/scope.json" }));
    expect(JSON.parse(vi.mocked(deps.out).mock.calls[0]![0]).results.findings[0].severity).toBe("critical");
    expect(process.exitCode ?? 0).toBe(0);
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
  it("collects all result pages and updates the combined report", async () => {
    const { runtime, deps } = setup();
    vi.mocked(runtime.getRunResults)
      .mockReturnValueOnce({ findings: [{ id: "first" }], report: { findings: [{ id: "first" }] }, totalFindings: 2, nextCursor: 100 })
      .mockReturnValueOnce({ findings: [{ id: "second" }], nextCursor: null });
    await runWorkflowCommand("saved", {}, deps);
    expect(runtime.getRunResults).toHaveBeenNthCalledWith(2, "run-1", { cursor: 100, limit: 100 });
    const results = JSON.parse(vi.mocked(deps.out).mock.calls[0]![0]).results;
    expect(results.findings.map((finding: { id: string }) => finding.id)).toEqual(["first", "second"]);
    expect(results.report.findings).toEqual(results.findings);
    expect(results.nextCursor).toBeNull();
  });
  it("rejects non-advancing pagination instead of looping or claiming complete results", async () => {
    const { runtime, deps } = setup();
    vi.mocked(runtime.getRunResults).mockReturnValue({ findings: [], nextCursor: 100 });
    await runWorkflowCommand("saved", {}, deps);
    expect(runtime.getRunResults).toHaveBeenCalledTimes(2);
    expect(deps.out).not.toHaveBeenCalled();
    expect(deps.err).toHaveBeenCalledWith("Invalid result pagination cursor.");
    expect(process.exitCode).toBe(2);
  });
  it("binds bounded artifact inputs and explicitly grants patch permission to host and run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
    try {
      const inputs = join(directory, "inputs.json");
      writeFileSync(inputs, JSON.stringify({ finding: { id: "finding-1" }, artifact: "evidence" }));
      const { runtime, deps } = setup();
      await runWorkflowCommand("saved", { inputs, allowApply: true }, deps);
      expect(deps.createRuntime).toHaveBeenCalledWith(expect.objectContaining({ allowApply: true }));
      expect(runtime.startRun).toHaveBeenCalledWith(expect.objectContaining({ inputs: { finding: { id: "finding-1" }, artifact: "evidence" }, allowApply: true }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("rejects oversized, malformed, and non-object input files before launching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
    try {
      const inputs = join(directory, "inputs.json");
      for (const contents of [" ".repeat(256 * 1024 + 1), JSON.stringify({ value: "x".repeat(32 * 1024) }), "{broken", "[]", "null", "42"]) {
        writeFileSync(inputs, contents);
        const { runtime, deps } = setup();
        await runWorkflowCommand("saved", { inputs }, deps);
        expect(runtime.startRun).not.toHaveBeenCalled();
        expect(deps.err).toHaveBeenCalled();
        expect(runtime.dispose).toHaveBeenCalledOnce();
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("uses saved target and enforces a requested revision", async () => {
    const { runtime, deps } = setup();
    await runWorkflowCommand("saved", { revision: "4" }, deps);
    expect(runtime.startRun).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "saved", revision: 4, target: "/repo" }));
  });
  it("does not start when selectors conflict or limits are invalid", async () => {
    for (const options of [{ template: "repository-review", target: "/repo" }, { target: "/repo", timeCap: "NaN" }, { target: "/repo", revision: "1.5" }]) {
      const { runtime, deps } = setup();
      await runWorkflowCommand("saved", options, deps);
      expect(runtime.startRun).not.toHaveBeenCalled();
      expect(deps.err).toHaveBeenCalled();
    }
  });
  it("retains failed results and sets an execution error exit code", async () => {
    const { runtime, deps } = setup();
    vi.mocked(runtime.getRun).mockReturnValue(fixture("failed"));
    await runWorkflowCommand("saved", {}, deps);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(vi.mocked(deps.out).mock.calls[0]![0]).run.status).toBe("failed");
  });
  it("cancels the foreground run on SIGINT and removes its handler", async () => {
    const { runtime, deps } = setup();
    const previous = process.listenerCount("SIGINT");
    vi.mocked(deps.sleep).mockImplementation(async () => { process.emit("SIGINT"); });
    vi.mocked(runtime.getRun).mockReturnValue(fixture("cancelled"));
    await runWorkflowCommand("saved", {}, deps);
    expect(runtime.cancelRun).toHaveBeenCalledWith("run-1");
    expect(process.exitCode).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(previous);
  });
  it("exposes discovery and persisted inspection through commander", async () => {
    const { runtime, deps } = setup();
    const program = new Command();
    registerWorkflowCommand(program, deps);
    await program.parseAsync(["workflow", "list", "--templates"], { from: "user" });
    expect(runtime.listTemplates).toHaveBeenCalledOnce();
    expect(runtime.listWorkflows).not.toHaveBeenCalled();
    await program.parseAsync(["runs", "show", "run-1", "--format", "json"], { from: "user" });
    expect(runtime.getRunResults).toHaveBeenCalledWith("run-1");
  });
  it("reports host cancellation errors instead of pretending another process was cancelled", async () => {
    const { runtime, deps } = setup();
    vi.mocked(runtime.cancelRun).mockImplementation(() => { throw new Error("Run is not owned by this host."); });
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["runs", "cancel", "run-1"], { from: "user" });
    expect(deps.err).toHaveBeenCalledWith(JSON.stringify({ error: "Run is not owned by this host." }));
    expect(process.exitCode).toBe(2);
  });
});


describe("remote workflow CLI selection", () => {
  it("uses remote targets and inputs without a local model, root or storage", async () => {
    const { runtime, deps } = setup();
    deps.createRemoteRuntime = vi.fn(async () => runtime);
    await runWorkflowCommand(undefined, { template: "repository-review", backend: "engine-one", backendsConfig: "/operator/backends.json", target: "D:\\engine\\repo" }, deps);
    expect(deps.createRemoteRuntime).toHaveBeenCalledWith({ backendId: "engine-one", configPath: "/operator/backends.json" });
    expect(deps.createRuntime).not.toHaveBeenCalled();
    expect(runtime.startRun).toHaveBeenCalledWith(expect.objectContaining({ target: "D:\\engine\\repo" }));
  });
  it("rejects local execution flags and never creates a local runtime on remote failure", async () => {
    for (const options of [{ workspace: "/repo" }, { scope: "/scope.json" }, { dbPath: "/local.db" }, { model: "local-model" }]) {
      const { runtime, deps } = setup(); deps.createRemoteRuntime = vi.fn(async () => runtime);
      await runWorkflowCommand(undefined, { backend: "engine-one", template: "review", target: "/engine/repo", ...options }, deps);
      expect(deps.createRuntime).not.toHaveBeenCalled(); expect(deps.createRemoteRuntime).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    }
  });
});
