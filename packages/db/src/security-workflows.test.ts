import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecurityWorkflowStore } from "./security-workflows.js";
const draft = () => ({ name: "Dependency review", instructions: "Review dependencies", target: "source:/workspace", nodes: [{ id: "start", type: "trigger", label: "Manual", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }], edges: [{ source: "start", target: "audit" }] });
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("durable security workflows", () => {
  it("retains a template snapshot and evidence across reopen without saving a workflow clone", () => {
    const directory = mkdtempSync(join(tmpdir(), "zero-workflow-results-")); directories.push(directory);
    const path = join(directory, "control.db");
    let store = new SecurityWorkflowStore(path);
    const execution = store.createExecutionFromSnapshot({ ...draft(), id: "template-dependencies", revision: 2 }, "cli");
    const result = { status: "completed", findings: [{ id: "finding-a", verification: { status: "unconfirmed" } }], artifacts: ["scan-a/state.db"] };
    store.saveExecutionResults(execution.id, result);
    store.updateExecution(execution.id, { status: "completed" });
    expect(store.list()).toEqual([]);
    store.close();
    store = new SecurityWorkflowStore(path);
    try {
      expect(store.getExecution(execution.id)?.workflowRevision).toBe(2);
      expect(store.getExecutionResults(execution.id)).toEqual(result);
      expect(store.list()).toEqual([]);
    } finally { store.close(); }
  });
  it("refuses orphan and oversized result writes without replacing retained evidence", () => {
    const store = new SecurityWorkflowStore(":memory:");
    try {
      expect(() => store.saveExecutionResults("missing", {})).toThrow(/not found/);
      const execution = store.createExecutionFromSnapshot(draft(), "cli");
      store.saveExecutionResults(execution.id, { evidence: "original" });
      expect(() => store.saveExecutionResults(execution.id, { evidence: "x".repeat(16 * 1024 * 1024) })).toThrow(/16 MiB/);
      expect(store.getExecutionResults(execution.id)).toEqual({ evidence: "original" });
    } finally { store.close(); }
  });
  it("persists optimistic revisions and immutable execution snapshots across reopen and definition deletion", () => {
    const directory = mkdtempSync(join(tmpdir(), "zero-workflow-store-")); directories.push(directory); const path = join(directory, "control.db");
    let store = new SecurityWorkflowStore(path);
    const first = store.save(draft());
    const execution = store.createExecution(first.id, "session-a", first.revision);
    const { createdAt: _created, updatedAt: _updated, ...input } = first;
    const second = store.save({ ...input, name: "Updated review" });
    expect(second.revision).toBe(2);
    expect(() => store.save(input)).toThrow(/changed/);
    expect(() => store.createExecution(first.id, "session-a", 1)).toThrow(/changed/);
    expect(store.getExecution(execution.id)?.workflow.name).toBe("Dependency review");
    store.updateExecution(execution.id, { status: "running", jobId: "job-parent", nodeResults: { audit: { status: "running", jobId: "job-child", scanIds: ["scan-a"], dbPaths: ["/proof/scan.db"] } } });
    store.close(); store = new SecurityWorkflowStore(path);
    expect(store.list()[0]?.name).toBe("Updated review");
    expect(store.listExecutions(undefined, "other-session")).toEqual([]);
    expect(store.interruptActiveExecutions()).toBe(0); // A concurrent live engine owns this execution.
    expect(store.interruptActiveExecutions(() => false)).toBe(1);
    expect(store.interruptActiveExecutions()).toBe(0);
    expect(store.getExecution(execution.id)?.status).toBe("interrupted");
    expect(store.getExecution(execution.id)?.ownerPid).toBe(process.pid);
    expect(store.getExecution(execution.id)?.runnerInstanceId).toBeTruthy();
    expect(store.getExecution(execution.id)?.nodeResults.audit?.scanIds).toEqual(["scan-a"]);
    expect(() => store.updateExecution(execution.id, { status: "running" })).toThrow(/finished/);
    expect(store.delete(first.id, 2)).toBe(true);
    expect(store.getExecution(execution.id)?.workflow.revision).toBe(1);
    store.close();
  });
  it("rejects unknown results and forbids snapshot replacement through execution patches", () => {
    const store = new SecurityWorkflowStore(":memory:");
    try {
      const workflow = store.save(draft()); const execution = store.createExecution(workflow.id, "session-a");
      expect(() => store.updateExecution(execution.id, { nodeResults: { missing: { status: "completed" } } })).toThrow(/node results/);
      const patch = { status: "running" as const, workflow: { name: "Injected" }, workflowRevision: 99 };
      expect(store.updateExecution(execution.id, patch).workflow).toEqual(workflow);
      expect(store.getExecution(execution.id)?.workflowRevision).toBe(1);
      store.updateExecution(execution.id, { status: "completed" });
      expect(store.interruptActiveExecutions()).toBe(0);
    } finally { store.close(); }
  });
});
