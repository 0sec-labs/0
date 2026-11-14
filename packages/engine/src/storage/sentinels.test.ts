import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SentinelStore, SentinelStoreError } from "./sentinels.js";
import { SecurityWorkflowStore } from "./security-workflows.js";
import { createSecurityWorkflowTemplate } from "../shared/security-workflow-templates.js";

const dirs: string[] = [];
const open = () => { const dir = mkdtempSync(join(tmpdir(), "zero-sentinel-")); dirs.push(dir); return { dir, path: join(dir, "control.db") }; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const status = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof SentinelStoreError ? error.statusCode : -1; } return 0; };

describe("SentinelStore", () => {
  it("creates inert defaults and seeds default files", () => {
    const store = new SentinelStore(":memory:");
    const sentinel = store.create({ name: "Watcher", instructions: "Watch deps." });
    expect(sentinel).toMatchObject({ status: "paused", autonomy: "propose", toolAccess: "read-only", homeMissionId: null, version: 1, hostId: null, model: null });
    expect(sentinel.scope.production).toBe(false);
    expect(sentinel.budget).toEqual({ dailyUsd: 10, maxRunsPerDay: 20 });
    expect(sentinel.crew).toEqual({ maxConcurrent: 4, maxDepth: 2, crewHost: null });
    expect(store.listFiles(sentinel.id).map(file => file.path)).toEqual(["AGENTS.md", "CREW.md", "NOTES.md"]);
    expect(store.getFile(sentinel.id, "AGENTS.md")?.content).toContain("Watch deps.");
    store.close();
  });
  it("rejects invalid input, triggers fields and caps", () => {
    const store = new SentinelStore(":memory:");
    expect(status(() => store.create({ name: "" }))).toBe(400);
    expect(status(() => store.create({ name: "x", triggers: [] }))).toBe(400);
    expect(status(() => store.create({ name: "x", crew: { maxConcurrent: 9 } }))).toBe(400);
    expect(status(() => store.create({ name: "x", crew: { maxDepth: 4 } }))).toBe(400);
    expect(status(() => store.create({ name: "x", budget: { perRunUsd: 50, dailyUsd: 10 } }))).toBe(400);
    expect(status(() => store.create({ name: "x", budget: { dailyUsd: 10, dailyTimeCapMs: 1000 } }))).toBe(400);
    expect(status(() => store.create({ name: "x", skills: ["a", "a"] }))).toBe(400);
    store.close();
  });
  it("uses optimistic versions for edits, status and delete", () => {
    const store = new SentinelStore(":memory:");
    const sentinel = store.create({ name: "A" });
    const updated = store.update(sentinel.id, { version: 1, name: "B", crew: { maxConcurrent: 8 } });
    expect(updated).toMatchObject({ name: "B", version: 2 });
    expect(updated.crew.maxDepth).toBe(2);
    expect(status(() => store.update(sentinel.id, { version: 1, name: "C" }))).toBe(409);
    expect(status(() => store.update("missing", { version: 1 }))).toBe(404);
    expect(store.setStatus(sentinel.id, "active", 2).status).toBe("active");
    expect(status(() => store.setStatus(sentinel.id, "paused", 2))).toBe(409);
    store.setStatus(sentinel.id, "archived");
    expect(status(() => store.setStatus(sentinel.id, "active"))).toBe(409);
    expect(status(() => store.delete(sentinel.id, 1))).toBe(409);
    expect(store.delete(sentinel.id)).toBe(true);
    expect(store.get(sentinel.id)).toBeNull();
    expect(store.delete(sentinel.id)).toBe(false);
    store.close();
  });
  it("binds the home mission once and tracks activations", () => {
    const store = new SentinelStore(":memory:");
    const sentinel = store.create({ name: "A" });
    expect(store.setHomeMission(sentinel.id, "m1").homeMissionId).toBe("m1");
    expect(store.setHomeMission(sentinel.id, "m2").homeMissionId).toBe("m1");
    const activation = store.createActivation({ sentinelId: sentinel.id, sentinelVersion: 1, trigger: { kind: "manual" }, status: "running", missionId: "m3", parentMissionId: "m1", automationId: "wf", skills: ["a"] });
    store.updateActivation(activation.id, { status: "completed", costUsd: 0.5, finishedAt: new Date().toISOString() });
    expect(store.listActivations(sentinel.id)[0]).toMatchObject({ status: "completed", missionId: "m3", automationId: "wf", costUsd: 0.5 });
    expect(store.countActivationsSince(sentinel.id, "2000-01-01T00:00:00Z")).toBe(1);
    expect(status(() => store.createActivation({ sentinelId: "nope", sentinelVersion: 1, trigger: { kind: "manual" }, status: "queued", skills: [] }))).toBe(404);
    store.close();
  });
  it("versions virtual files with reviewable revisions and guards", () => {
    const store = new SentinelStore(":memory:");
    const sentinel = store.create({ name: "A" });
    const first = store.putFile(sentinel.id, "NOTES.md", "- FP: scanner x", 1, "agent", "sentinel");
    expect(first.revision).toBe(2);
    expect(status(() => store.putFile(sentinel.id, "NOTES.md", "stale", 1, "human", "me"))).toBe(409);
    store.putFile(sentinel.id, "reports/2026-01-01.md", "# r", null, "agent", "sentinel");
    expect(status(() => store.putFile(sentinel.id, "reports/2026-01-01.md", "# r", null, "agent", "s"))).toBe(409);
    expect(store.listFileRevisions(sentinel.id, "NOTES.md").map(revision => [revision.revision, revision.authorKind])).toEqual([[2, "agent"], [1, "human"]]);
    for (const bad of ["../x.md", "/etc/passwd.md", "a\\b.md", "notes.exe", "a/b/c/d/e.md", "__proto__/x.md"]) expect(status(() => store.putFile(sentinel.id, bad, "x", null, "human", "me")), bad).toBe(400);
    expect(status(() => store.putFile(sentinel.id, "big.md", "x".repeat(70_000), null, "human", "me"))).toBe(400);
    expect(status(() => store.deleteFile(sentinel.id, "AGENTS.md"))).toBe(409);
    expect(store.deleteFile(sentinel.id, "reports/2026-01-01.md", 1)).toBe(true);
    expect(store.getFile(sentinel.id, "reports/2026-01-01.md")).toBeNull();
    store.close();
  });
  it("deleting a Sentinel removes files but keeps activations and automations", () => {
    const { path } = open();
    const store = new SentinelStore(path);
    const workflows = new SecurityWorkflowStore(path);
    const sentinel = store.create({ name: "A" });
    const workflow = workflows.save({ ...createSecurityWorkflowTemplate("repository-review", { target: "." }), ownerSentinelId: sentinel.id, runIn: "sentinel-home" });
    store.createActivation({ sentinelId: sentinel.id, sentinelVersion: 1, trigger: { kind: "manual" }, status: "completed", skills: [] });
    store.delete(sentinel.id);
    expect(store.listFiles.bind(store, sentinel.id)).toThrow(/not found/);
    expect(store.listActivations(sentinel.id)).toHaveLength(1);
    expect(workflows.get(workflow.id)?.ownerSentinelId).toBe(sentinel.id);
    store.close();
  });
  it("opens an existing database additively and shares it across handles", () => {
    const { path } = open();
    const workflows = new SecurityWorkflowStore(path);
    const first = new SentinelStore(path);
    const second = new SentinelStore(path);
    const sentinel = first.create({ name: "Shared" });
    expect(second.get(sentinel.id)?.name).toBe("Shared");
    expect(workflows.list()).toEqual([]);
    first.close(); second.close();
  });

  it("patches only the named fields and keeps everything else", () => {
    const store = new SentinelStore(":memory:");
    const created = store.create({ name: "A", skills: ["x"], status: "active", budget: { dailyUsd: 3 }, scope: { targets: ["https://a.example"] } });
    const patched = store.update(created.id, { version: 1, name: "B" });
    expect(patched).toMatchObject({ name: "B", skills: ["x"], status: "active", budget: { dailyUsd: 3 }, scope: { targets: ["https://a.example"] } });
    expect(status(() => store.update(created.id, { version: 2, bogus: 1 }))).toBe(400);
    store.close();
  });
});
