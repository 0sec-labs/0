import { afterEach, describe, expect, it } from "vitest";
import { SecurityWorkflowStore, learningProjectId } from "@0/db";
import { WebLearningService } from "./learning.js";

const definitions: SecurityWorkflowStore[] = [];
const services: WebLearningService[] = [];
function fixture() {
  const store = new SecurityWorkflowStore(":memory:"); definitions.push(store);
  const service = new WebLearningService(store); services.push(service);
  return { store, service };
}
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const store of definitions.splice(0)) store.close(); });
const draft = { name: "Review", instructions: "", target: "source:/workspace/a", nodes: [{ id: "start", type: "trigger", label: "Manual", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }], edges: [{ source: "start", target: "audit" }] };
const query = () => new URLSearchParams();

describe("customer-local learning HTTP", () => {
  it("processes durable workflow observations through the same control database", async () => {
    const { store, service } = fixture();
    const workflow = store.save(draft);
    const run = store.createExecution(workflow.id, "owner", workflow.revision);
    store.updateExecution(run.id, { status: "completed" });
    expect((await service.handle("/api/console/learning", "GET", undefined, query()))?.data).toMatchObject({ events: [expect.objectContaining({ workflowId: workflow.id, evidenceStrength: "operational" })], worker: { configuredEvaluation: false } });
    await service.handle("/api/console/learning/process", "POST", { limit: 10 }, query());
    const response = await service.handle("/api/console/learning", "GET", undefined, new URLSearchParams({ workflowId: workflow.id }));
    expect(response?.status).toBe(200);
    // Completion is useful activity, but is not a reusable security lesson.
    expect((response?.data as { knowledge: unknown[] }).knowledge).toEqual([]);
  });
  it("records chat metadata without storing messages, and scopes workflow knowledge", async () => {
    const { store, service } = fixture();
    service.recordChatOutcome({ id: "session:turn", project: "/workspace/b", outcome: "completed" });
    service.recordChatOutcome({ id: "session:turn", project: "/workspace/b", outcome: "completed" });
    expect(service.store.listEvents()).toHaveLength(1);
    expect(JSON.stringify(service.store.listEvents())).not.toContain("/workspace/b");
    const workflow = store.save(draft);
    const projectId = learningProjectId(workflow.target);
    const own = service.store.appendEvent({ idempotencyKey: "own", projectId, kind: "source-context", outcome: "current", summary: "Grounded context" });
    service.store.putKnowledge({ projectId, summary: "Own note", evidenceEventIds: [own.id], sourceLinks: [] });
    const foreign = service.store.listEvents().find(event => event.id !== own.id)!;
    service.store.putKnowledge({ projectId: foreign.projectId, summary: "Other note", evidenceEventIds: [foreign.id], sourceLinks: [] });
    const response = await service.handle("/api/console/learning", "GET", undefined, new URLSearchParams({ workflowId: workflow.id }));
    expect((response?.data as { knowledge: { summary: string }[] }).knowledge.map(entry => entry.summary)).toEqual(["Own note"]);
  });
  it("rejects forged evaluation, unknown mutations and invalid limits", async () => {
    const { service } = fixture();
    expect((await service.handle("/api/console/learning/evaluations", "POST", { passed: true }, query()))?.status).toBe(405);
    expect((await service.handle("/api/console/learning", "GET", undefined, new URLSearchParams("limit=NaN")))?.status).toBe(400);
    expect((await service.handle("/api/console/learning/process", "POST", { limit: 1000 }, query()))?.status).toBe(400);
    expect(await service.handle("/api/console/learningevil", "GET", undefined, query())).toBeNull();
  });
  it("keeps mirrored evolution deployment authority in its registry", async () => {
    const { service } = fixture();
    const event = service.store.appendEvent({ idempotencyKey: "registry-event", projectId: "project", kind: "evolution", outcome: "proposed", summary: "Registry observation" });
    const mirrored = service.store.mirrorRegistryCandidate({ projectId: "project", kind: "lens", targetId: "lens", baseVersion: "v1", proposal: "Recipe", evidenceEventIds: [event.id], registry: { registryVersionId: "version-a", registryStorePath: "/local/registry", snapshotDigest: "snapshot", registryStatus: "candidate" } }, "proposed");
    for (const action of ["reject", "evaluate"]) {
      expect((await service.handle(`/api/console/learning/improvements/${mirrored.id}/${action}`, "POST", { revision: mirrored.revision }, query()))?.status).toBe(409);
    }
    expect(service.store.getCandidate(mirrored.id)?.status).toBe("proposed");
  });
  it("requires fresh evidence for stale knowledge and CAS for rejection", async () => {
    const { service } = fixture();
    const event = service.store.appendEvent({ idempotencyKey: "event", projectId: "project", kind: "source-context", outcome: "current", summary: "Context" });
    const entry = service.store.putKnowledge({ projectId: "project", summary: "Note", evidenceEventIds: [event.id], sourceLinks: [{ path: "file.ts", hash: "sha256:old" }] });
    service.store.invalidateKnowledge("project", {});
    expect((await service.handle(`/api/console/learning/knowledge/${entry.id}`, "PATCH", { status: "current" }, query()))?.status).toBe(409);
    const candidate = service.store.createCandidate({ projectId: "project", kind: "skill", targetId: "skill", baseVersion: "v1", proposal: "A bounded change", evidenceEventIds: [event.id] });
    expect((await service.handle(`/api/console/learning/improvements/${candidate.id}/evaluate`, "POST", { revision: 1 }, query()))?.status).toBe(409);
    expect(service.store.getCandidate(candidate.id)?.status).toBe("proposed");
    expect((await service.handle(`/api/console/learning/improvements/${candidate.id}/reject`, "POST", { revision: 2 }, query()))?.status).toBe(409);
    expect((await service.handle(`/api/console/learning/improvements/${candidate.id}/reject`, "POST", { revision: 1 }, query()))?.status).toBe(200);
  });
});
