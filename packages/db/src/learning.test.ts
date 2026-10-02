import { mkdtempSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LearningStore, learningArtifactDigest, learningProjectId } from "./learning.js";
const stores: LearningStore[] = [];
const directories: string[] = [];
const open = (path = ":memory:") => { const store = new LearningStore(path); stores.push(store); return store; };
const event = (key = "event-a", projectId = "project-a") => ({ idempotencyKey: key, projectId, kind: "workflow-terminal", outcome: "completed", evidenceStrength: "operational" as const, summary: "Workflow execution completed." });
afterEach(() => { for (const store of stores.splice(0)) { try {store.close();} catch {} } for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("tenant-local durable learning", () => {
  it("keeps experiences and outbox after reopen; retries are idempotent and conflicts fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "learning-")); directories.push(dir); const path = join(dir, "control.db");
    const first = open(path); const saved = first.recordExperience(event()); first.close(); stores.pop();
    const second = open(path); expect(second.getEvent(saved.id)).toEqual(saved); expect(second.recordExperience(event())).toEqual(saved);
    expect(second.queueStatus()).toEqual({pending:1,claimed:0,completed:0});
    expect(() => second.appendEvent({...event(), outcome:"failed"})).toThrow(/different event/);
    expect(second.getEvent(saved.id)?.outcome).toBe("completed");
  });
  it("deduplicates workflow suggestions durably even after dismissal and reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "learning-suggestion-")); directories.push(dir); const path=join(dir,"control.db");
    const first=open(path);const source=first.appendEvent(event());
    const input={projectId:"project-a",kind:"workflow-restore",targetId:"workflow",baseVersion:"2",proposal:"Restore the reviewed earlier instructions",evidenceEventIds:[source.id]};
    const candidate=first.createWorkflowSuggestion(input)!;
    first.transitionCandidate(candidate.id,1,"rejected");first.close();stores.pop();
    const second=open(path);expect(second.createWorkflowSuggestion(input)).toBeNull();expect(second.listCandidates()).toHaveLength(1);
    expect(second.createWorkflowSuggestion({...input,baseVersion:"3"})).not.toBeNull();
  });
  it("enforces bounded structured inputs without storing opaque capture or credentials", () => {
    const store = open(); expect(() => store.appendEvent({...event(), summary:"api_key=sk-secret"})).toThrow(/Credential/);
    expect(() => store.appendEvent({...event(), summary:"x".repeat(4001)})).toThrow(/summary/);
    expect(() => store.appendEvent({...event(), rawPrompt:"anything"} as never)).toThrow(/fields/);
    expect(store.listEvents()).toEqual([]);
  });
  it("keeps queue claims exclusive across stores and recovers expired claims without stale acknowledgments", () => {
    const dir = mkdtempSync(join(tmpdir(), "learning-claim-")); directories.push(dir); const path = join(dir, "control.db");
    const first = open(path); first.recordExperience(event()); first.recordExperience(event("other", "project-b")); const second = open(path); const now = Date.now()+100;
    const claim = first.claimWork("worker-a", 1000, now, "project-a")!;
    expect(second.claimWork("worker-b", 1000, now, "project-a")).toBeNull();
    const recovered = second.claimWork("worker-b", 1000, now+1000, "project-a")!;
    expect(recovered.id).toBe(claim.id); expect(recovered.attempts).toBe(2); expect(recovered.claimToken).not.toBe(claim.claimToken);
    expect(() => first.completeWork(claim.id, claim.claimToken!, now+1001)).toThrow(/lease/);
    second.retryWork(recovered.id,recovered.claimToken!,500,now+1001);
    expect(first.claimWork("worker-c",1000,now+1400,"project-a")).toBeNull();
    const retry = first.claimWork("worker-c",1000,now+1501,"project-a")!; first.completeWork(retry.id,retry.claimToken!,now+1502);
    expect(first.queueStatus("project-a")).toEqual({pending:0,claimed:0,completed:1}); expect(first.queueStatus("project-b").pending).toBe(1);
  });
  it("requires same-project provenance, deduplicates knowledge, and invalidates changed or missing files", () => {
    const store = open(); const a = store.appendEvent(event()); const b = store.appendEvent(event("b","project-b"));
    const input = {projectId:"project-a",summary:"Handlers enforce tenant scoping.",evidenceEventIds:[a.id],sourceLinks:[{path:"src/api.ts",hash:"hash-a"}]};
    expect(() => store.putKnowledge({...input,evidenceEventIds:[b.id]})).toThrow(/same project/);
    const note = store.putKnowledge(input); expect(store.putKnowledge(input).id).toBe(note.id);
    expect(store.invalidateKnowledge("project-a",{"src/api.ts":"hash-a"})).toBe(0);
    expect(store.invalidateKnowledge("project-a",{"src/api.ts":"hash-b"})).toBe(1); expect(store.getKnowledge(note.id)?.status).toBe("stale");
    expect(() => store.setKnowledgeStatus(note.id,"current")).toThrow(/fresh evidence/);
    const other = store.putKnowledge({...input,summary:"New observation."}); expect(store.invalidateKnowledge("project-a",{})).toBe(1); expect(store.getKnowledge(other.id)?.status).toBe("stale");
  });
  it("gates candidate activation on matching receipts, enforces CAS, and restores previous version", () => {
    const store = open(); const source = store.appendEvent(event());
    const create = (proposal:string) => store.createCandidate({projectId:"project-a",kind:"skill",targetId:"verification",baseVersion:"v1",proposal,evidenceEventIds:[source.id]});
    const validate = (proposal:string) => {const candidate = create(proposal); const evaluating = store.transitionCandidate(candidate.id,candidate.revision,"evaluating"); return store.recordEvaluation(evaluating.id,evaluating.revision,{suiteDigest:"suite",baselineDigest:"baseline",candidateDigest:learningArtifactDigest(proposal),passed:true,metrics:{cases:12}});};
    const first = create("proposal-first"); expect(() => store.activateCandidate(first.id,1)).toThrow(/passing evaluation/); expect(() => store.transitionCandidate(first.id,1,"active")).toThrow(/transition/);
    const running = store.transitionCandidate(first.id,1,"evaluating"); expect(() => store.recordEvaluation(first.id,1,{suiteDigest:"suite",baselineDigest:"base",candidateDigest:first.artifactDigest!,passed:true,metrics:{}})).toThrow(/changed/);
    expect(() => store.recordEvaluation(first.id,running.revision,{suiteDigest:"suite",baselineDigest:"base",candidateDigest:"wrong",passed:true,metrics:{}})).toThrow(/artifact/);
    const inconclusive = store.recordEvaluation(first.id,running.revision,{suiteDigest:"suite",baselineDigest:"base",candidateDigest:first.artifactDigest!,passed:false,outcome:"inconclusive",metrics:{}}); expect(inconclusive.status).toBe("evaluating");
    const v1 = validate("recipe v1"); const active = store.activateCandidate(v1.id,v1.revision); const v2 = validate("recipe v2");
    expect(() => store.activateCandidate(v2.id,v2.revision)).toThrow(/Active version changed/);
    const updated = store.activateCandidate(v2.id,v2.revision,active.id); expect(store.getCandidate(active.id)?.status).toBe("retired");
    store.rollbackCandidate(updated.id,updated.revision); expect(store.getActiveCandidate("project-a","skill","verification")?.id).toBe(active.id);
    expect(store.getCandidate(v2.id)?.status).toBe("retired"); expect(store.getCandidate(v1.id)?.evaluations).toEqual(v1.evaluations);
  });
  it("mirrors existing fixture registry lifecycle without calling it security validation", () => {
    const store = open(); const source = store.appendEvent(event()); const input = {projectId:"project-a",kind:"lens",targetId:"lens",baseVersion:"v1",proposal:"recipe",evidenceEventIds:[source.id],registry:{registryVersionId:"version-a",registryStorePath:"/local/registry",snapshotDigest:"snapshot",registryStatus:"candidate" as const}};
    const receipt = {suiteDigest:"fixture-suite",baselineDigest:"baseline",candidateDigest:"snapshot",passed:false,evaluationKind:"output-fixture" as const,metrics:{cases:12}};
    const rejected = store.mirrorRegistryCandidate(input,"rejected",[receipt]); expect(rejected.status).toBe("rejected"); expect(rejected.evaluations[0]?.evaluationKind).toBe("output-fixture");
    expect(store.mirrorRegistryCandidate(input,"rejected",[receipt]).evaluations).toHaveLength(1);
    expect(() => store.mirrorRegistryCandidate(input,"active")).toThrow(/match the registry/);
    expect(() => store.mirrorRegistryCandidate({...input,proposal:"changed"},"rejected")).toThrow(/Immutable/);
  });
  it("normalizes local source prefixes, relative paths, and existing symlinks to the native root identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "learning-source-")); directories.push(dir);
    const canonical = realpathSync(dir);
    expect(learningProjectId(`source:${dir}`)).toBe(learningProjectId(canonical));
    expect(learningProjectId(`source:${relative(process.cwd(), dir)}`)).toBe(learningProjectId(canonical));
    expect(learningProjectId(`./${relative(process.cwd(), dir)}`)).toBe(learningProjectId(canonical));
    symlinkSync(dir, join(dir, "alias"));
    expect(learningProjectId(`source:${join(dir, "alias")}`)).toBe(learningProjectId(canonical));
    expect(learningProjectId("https://example.test/repo")).not.toBe(learningProjectId("source:./https/example.test/repo"));
    expect(learningProjectId("https://user:password@example.test/repo")).not.toContain("password");
    expect(learningProjectId("project-a")).not.toBe(learningProjectId("source:project-a"));
  });
  it("uses stable target-scoped identifiers without putting paths in project identifiers", () => {expect(learningProjectId(" /repo ")).toBe(learningProjectId("/repo")); expect(learningProjectId("/repo")).not.toContain("/repo");});
});
