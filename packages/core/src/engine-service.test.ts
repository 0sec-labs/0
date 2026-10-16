import { describe, expect, it, vi } from "vitest";
import type { SecurityWorkflowExecution } from "@0/shared";
import { EngineService, type EngineServiceOptions } from "./engine-service.js";

function fixture(overrides: Partial<EngineServiceOptions> = {}) {
  const execution = { id: "shared-run", sessionId: "browser-session", status: "running" } as SecurityWorkflowExecution;
  const snapshot = { session: { id: "browser-session" }, cursor: 7, messages: [] };
  const sessions = { list: vi.fn(() => [{ id: "browser-session" }]), create: vi.fn(() => ({ id: "created" })), get: vi.fn(() => snapshot),
    send: vi.fn(), continue: vi.fn(), cancel: vi.fn(), resolveDecision: vi.fn(), listSaved: vi.fn(() => [{ id: "saved" }]),
    resume: vi.fn(() => ({ id: "resumed" })), eventsAfter: vi.fn(() => ({ cursor: 8, events: [], gap: false })) };
  const workflows = { getExecution: vi.fn((id: string) => id === execution.id ? execution : null), listExecutions: vi.fn(() => [execution]),
    invokeLifecycle: vi.fn(async (_session: string, name: string) => name === "start_run" ? { runId: execution.id } : name === "get_run" ? { run: execution, events: [{ sequence: 1, type: "state" }] } : name === "cancel_run" ? { cancellationRequested: true } : { findings: [] }) };
  const admitRun = vi.fn(async () => "browser-session");
  return { engine: new EngineService({ sessions, workflows, admitRun, ...overrides }), sessions, workflows, admitRun, execution, snapshot };
}
describe("shared engine facade", () => {
  it("launches and reads the same browser-owned run and resolves owner from stored execution", async () => {
    const f = fixture();
    expect(await f.engine.invoke("start_run", { sessionId: "browser-session", workflowId: "workflow", revision: 2, target: "/repo" })).toBe(f.execution);
    expect(f.workflows.invokeLifecycle).toHaveBeenCalledWith("browser-session", "start_run", { workflowId: "workflow", revision: 2, target: "/repo" }, { allowApply: false });
    expect(await f.engine.invoke("get_run", { runId: "shared-run" })).toEqual({ ...f.execution, events: [{ sequence: 1, type: "state" }] });
    expect(await f.engine.invoke("get_run_results", { runId: "shared-run", cursor: 2, limit: 5 })).toEqual({ findings: [] });
    expect(await f.engine.invoke("cancel_run", { runId: "shared-run" })).toMatchObject({ id: "shared-run", status: "running", cancellationRequested: true });
    expect(f.workflows.invokeLifecycle.mock.calls.slice(1).every(call => call[0] === "browser-session")).toBe(true);
    await expect(f.engine.invoke("get_run", { runId: "missing" })).rejects.toThrow("not found");
  });
  it("rejects authority overrides, invalid budgets, unpinned drafts and unauthorized apply before admission", async () => {
    const f = fixture();
    const base = { templateId: "review", target: "/repo" };
    for (const extra of [{ ownerId: "forged" }, { workspace: "/other" }, { model: "caller" }, { scopePath: "/scope" }, { timeCapMs: "100" }, { costCapUsd: Infinity }, { timeCapMs: 0 }, { inputs: { value: undefined } }, { allowApply: true }]) {
      await expect(f.engine.invoke("start_run", { ...base, ...extra })).rejects.toThrow();
    }
    await expect(f.engine.invoke("start_run", { workflowId: "draft", target: "/repo" })).rejects.toThrow("pinned revision");
    await expect(f.engine.invoke("start_run", { ...base, workflowId: "draft", revision: 1 })).rejects.toThrow("exactly one");
    expect(f.admitRun).not.toHaveBeenCalled(); expect(f.workflows.invokeLifecycle).not.toHaveBeenCalled();
    await expect(f.engine.invoke("cancel_run", { runId: "shared-run", sessionId: "forged" })).rejects.toThrow();
  });
  it("exposes existing session snapshots, cursors and saved-session resume without model allocation", async () => {
    const f = fixture();
    expect(await f.engine.invoke("get_session", { sessionId: "browser-session" })).toBe(f.snapshot);
    expect(await f.engine.invoke("attach_session", { sessionId: "browser-session" })).toBe(f.snapshot);
    expect(await f.engine.invoke("get_session_events", { sessionId: "browser-session", after: 7 })).toEqual({ cursor: 8, events: [], gap: false });
    expect(f.sessions.eventsAfter).toHaveBeenCalledWith("browser-session", 7);
    expect(await f.engine.invoke("resume_session", { savedSessionId: "saved" })).toEqual({ id: "resumed" });
    expect(f.sessions.resume).toHaveBeenCalledWith("saved"); expect(f.admitRun).not.toHaveBeenCalled();
    await expect(f.engine.invoke("get_session_events", { sessionId: "browser-session", after: -1 })).rejects.toThrow();
    await expect(f.engine.invoke("resume_session", { savedSessionId: "saved", ownerId: "forged" })).rejects.toThrow();
  });
  it("validates assessments before admission and advertises only bound optional lifecycle ports", async () => {
    const startAssessment = vi.fn(async () => ({ id: "assessment-run" } as SecurityWorkflowExecution));
    const f = fixture({ startAssessment });
    const plan = { goal: "unknown-vulnerabilities", depth: "deep", runCount: 1, executionMode: "sequential", timeCapMs: 1000, costCapUsd: 0.5 };
    for (const extra of [{ ownerId: "forged" }, { model: "caller" }, { scopePath: "/scope" }, { plan: { ...plan, timeCapMs: 0 } }, { plan: { ...plan, extra: "ignored" } }]) {
      await expect(f.engine.invoke("start_assessment", { target: "/repo", plan, ...extra })).rejects.toThrow();
    }
    expect(f.admitRun).not.toHaveBeenCalled(); expect(startAssessment).not.toHaveBeenCalled();
    expect(await f.engine.invoke("start_assessment", { target: "/repo", plan })).toEqual({ id: "assessment-run" });
    expect(startAssessment).toHaveBeenCalledWith("browser-session", { target: "/repo", plan });
    expect(await f.engine.invoke("get_capabilities", {})).toMatchObject({ schemaVersion: 1, operations: expect.arrayContaining(["start_assessment"]), resume: { session: true, scan: false, workflow: false }, reportExport: { formats: [] } });
    const unbound = fixture();
    const manifest = await unbound.engine.invoke("get_capabilities", {}) as { operations: string[] };
    expect(manifest.operations).not.toContain("start_assessment"); expect(manifest.operations).not.toContain("resume_scan");
    await expect(unbound.engine.invoke("start_assessment", { target: "/repo", plan })).rejects.toThrow("does not support");
    expect(unbound.admitRun).not.toHaveBeenCalled();
  });

});
