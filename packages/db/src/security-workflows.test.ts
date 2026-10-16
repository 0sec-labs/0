import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LearningStore, learningProjectId } from "./learning.js";
import { createShimmedDatabase } from "./wasm-shim.js";
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
  it("restores an immutable definition as a new revision and rejects stale restoration", () => {
    const store = new SecurityWorkflowStore(":memory:");
    try {
      const first = store.save(draft());
      const { createdAt: _created, updatedAt: _updated, ...input } = first;
      const second = store.save({ ...input, name: "Updated review" });
      const execution = store.createExecution(first.id, "session-a", second.revision);
      const restored = store.rollback(first.id, first.revision, second.revision);
      expect(restored.revision).toBe(3);
      expect(restored.name).toBe(first.name);
      expect(store.getVersion(first.id, 1)?.definition).toEqual(first);
      expect(store.getVersion(first.id, 2)?.definition).toEqual(second);
      expect(store.getVersion(first.id, 3)).toMatchObject({ parentRevision: 2, restoredFromRevision: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(store.listVersions(first.id).map(version => version.revision)).toEqual([3, 2, 1]);
      expect(store.getExecution(execution.id)?.workflow).toEqual(second);
      expect(() => store.rollback(first.id, 1, 2)).toThrow(/changed/);
      expect(() => store.rollback(first.id, 99, 3)).toThrow(/not found/);
      expect(() => store.rollback(first.id, 1, undefined as unknown as number)).toThrow(/revision/);
      expect(store.get(first.id)?.revision).toBe(3);
      store.delete(first.id, 3);
      expect(store.listVersions(first.id)).toHaveLength(3);
      expect(() => store.rollback(first.id, 1, 3)).toThrow(/not found/);
      expect(() => store.save({ ...draft(), id: first.id })).toThrow(/cannot be reused/);
    } finally { store.close(); }
  });
  it("bootstraps legacy current rows and known snapshots without inventing missing versions", () => {
    const directory = mkdtempSync(join(tmpdir(), "zero-workflow-versions-")); directories.push(directory);
    const path = join(directory, "control.db");
    let store = new SecurityWorkflowStore(path);
    const first = store.save(draft());
    store.createExecution(first.id, "session-a");
    store.createExecutionFromSnapshot({ ...draft(), id: "unsaved-template" }, "session-a");
    const { createdAt: _created, updatedAt: _updated, ...input } = first;
    const second = store.save({ ...input, name: "Intermediate" });
    const { createdAt: _created2, updatedAt: _updated2, ...input2 } = second;
    const latest = store.save({ ...input2, name: "Latest" });
    store.close();
    const legacy = createShimmedDatabase(path);
    legacy.exec("DROP TABLE workflow_definition_versions");
    legacy.close();
    store = new SecurityWorkflowStore(path);
    try {
      expect(store.listVersions(first.id).map(version => version.revision)).toEqual([3, 1]);
      expect(store.getVersion(first.id, 1)?.definition).toEqual(first);
      expect(store.getVersion(first.id, 2)).toBeNull();
      expect(store.getVersion(first.id, 3)?.definition).toEqual(latest);
      expect(store.listVersions("unsaved-template")).toEqual([]);
      const restored = store.rollback(first.id, 1, 3);
      expect(restored.revision).toBe(4);
    } finally { store.close(); }
    store = new SecurityWorkflowStore(path);
    try {
      expect(store.listVersions(first.id).map(version => version.revision)).toEqual([4, 3, 1]);
      expect(store.getVersion(first.id, 4)?.restoredFromRevision).toBe(1);
    } finally { store.close(); }
  });

  it("commits terminal run and step observations with durable learning work, without raw output", () => {
    const directory = mkdtempSync(join(tmpdir(), "zero-workflow-learning-")); directories.push(directory);
    const path = join(directory, "control.db");
    const store = new SecurityWorkflowStore(path);
    const first = store.save(draft());
    const execution = store.createExecution(first.id, "session-a");
    store.updateExecution(execution.id, { status: "running", nodeResults: { audit: { status: "completed", error: "private runtime details" } } });
    store.updateExecution(execution.id, { status: "running" });
    store.updateExecution(execution.id, { status: "completed" });
    expect(() => store.updateExecution(execution.id, { status: "completed" })).toThrow(/finished/);
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      const run = store.createExecution(first.id, "session-a");
      store.updateExecution(run.id, { status });
    }
    store.close();
    const learning = new LearningStore(path);
    try {
      const events = learning.listEvents({ projectId: learningProjectId(first.target) });
      expect(events).toHaveLength(5);
      expect(events.every(event => event.evidenceStrength === "operational")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("private runtime details");
      expect(events.filter(event => event.executionId === execution.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "workflow-step", outcome: "completed", stepId: "audit", workflowRevision: 1 }),
        expect.objectContaining({ kind: "workflow-run", outcome: "completed", workflowRevision: 1 }),
      ]));
      let queued = 0;
      for (;;) {
        const work = learning.claimWork("test-worker");
        if (!work) break;
        queued++;
        expect(learning.getEvent(work.eventId)).not.toBeNull();
        learning.completeWork(work.id, work.claimToken!);
      }
      expect(queued).toBe(5);
    } finally { learning.close(); }
  });
  it("rolls back execution status and learning events when the durable outbox write fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "zero-workflow-atomic-learning-")); directories.push(directory);
    const path = join(directory, "control.db");
    const store = new SecurityWorkflowStore(path);
    const workflow = store.save(draft());
    const execution = store.createExecution(workflow.id, "session-a");
    const connection = createShimmedDatabase(path);
    connection.exec("CREATE TRIGGER fail_learning_work BEFORE INSERT ON learning_work BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
    connection.close();
    try {
      expect(() => store.updateExecution(execution.id, { status: "completed", nodeResults: { audit: { status: "completed" } } })).toThrow(/outbox unavailable/);
      expect(store.getExecution(execution.id)?.status).toBe("queued");
      expect(store.getExecution(execution.id)?.nodeResults).toEqual({});
    } finally { store.close(); }
    const learning = new LearningStore(path);
    try { expect(learning.listEvents()).toEqual([]); expect(learning.claimWork("test-worker")).toBeNull(); }
    finally { learning.close(); }
  });

  it("shares learning persistence without giving the wrapper ownership of the control connection", () => {
    const store = new SecurityWorkflowStore(":memory:");
    try {
      const workflow = store.save(draft());
      const execution = store.createExecution(workflow.id, "session-a");
      store.updateExecution(execution.id, { status: "completed" });
      const learning = store.learningStore();
      expect(learning.listEvents()).toHaveLength(1);
      learning.close();
      expect(store.get(workflow.id)).toEqual(workflow);
    } finally { store.close(); }
  });

  it("captures valid credential-named step identifiers without treating identity as credential content", () => {
    const store = new SecurityWorkflowStore(":memory:");
    try {
      const input = draft();
      input.nodes[1]!.id = "access-token";
      input.edges[0]!.target = "access-token";
      const workflow = store.save(input);
      const execution = store.createExecution(workflow.id, "session-a");
      store.updateExecution(execution.id, { status: "running", nodeResults: { "access-token": { status: "completed" } } });
      store.updateExecution(execution.id, { status: "running" });
      store.updateExecution(execution.id, { status: "completed" });
      const events = store.learningStore().listEvents();
      expect(events).toHaveLength(2);
      expect(events.find(event => event.kind === "workflow-step")?.stepId).toBe("access-token");
      expect(events.every(event => /^workflow-terminal:[a-f0-9]{64}$/.test(event.idempotencyKey))).toBe(true);
      expect(store.getExecution(execution.id)?.status).toBe("completed");
    } finally { store.close(); }
  });

});
