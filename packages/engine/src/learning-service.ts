import { randomUUID } from "node:crypto";
import { SecurityWorkflowStore, workflowRestorePolicy, learningProjectId, LearningStore, type LearningEvaluationInput, type ImprovementCandidate, type LearningEvent } from "./storage/index.js";
import { evolutionDigest, loadEvolutionRegistry, loadEvolutionReceipt, verifyEvolutionSnapshot, receiptsDir } from "./improvement/registry.js";
import { readEvolutionArtifact } from "./improvement/artifacts.js";
import type { EvolutionConfig, EvolutionRunResult } from "./improvement/types.js";
import { resolve, join } from "node:path";

/** Only a trusted host adapter may execute evaluation; never supply this from a request body. */
export interface LearningEvaluator {
  evaluate(candidate: Readonly<ImprovementCandidate>, context: { signal: AbortSignal }): Promise<LearningEvaluationInput & { candidateId: string }>;
}
export interface LearningServiceOptions {
  evaluator?: LearningEvaluator;
  workflows?: SecurityWorkflowStore;
  maxEventsPerTick?: number;
  evaluationTimeoutMs?: number;
}
export interface LearningTickResult { proposed: number; processed: number; retained: number; skipped: number; retried: number }

/** Durable bounded derivation; no model calls, permission changes, or automatic activation. */
export class LearningService {
  private readonly owner = `learning-worker:${randomUUID()}`;
  private readonly maxEvents: number;
  private running = false;
  private readonly evaluating = new Set<string>();
  constructor(readonly store: LearningStore, private readonly options: LearningServiceOptions = {}) {
    this.maxEvents = Math.max(1, Math.min(100, Math.floor(Number.isFinite(options.maxEventsPerTick) ? options.maxEventsPerTick! : 25)));
  }
  get configuredEvaluation(): boolean { return Boolean(this.options.evaluator); }
  status(projectId?: string) {
    return { configuredEvaluation: this.configuredEvaluation, processing: this.running, retainedSampleLimit: 200,
      events: this.store.listEvents({ projectId, limit: 200 }).length,
      improvements: this.store.listCandidates({ projectId, limit: 200 }).length, queue: this.store.queueStatus(projectId) };
  }
  async processPending(options: { projectId?: string; limit?: number } = {}): Promise<LearningTickResult> {
    const result: LearningTickResult = { proposed: 0, processed: 0, retained: 0, skipped: 0, retried: 0 };
    if (this.running) return result;
    this.running = true;
    const cap = Math.min(this.maxEvents, Math.max(1, Math.floor(Number.isFinite(options.limit) ? options.limit! : this.maxEvents)));
    try {
      for (let index = 0; index < cap; index++) {
        const work = this.store.claimWork(this.owner, 60_000, Date.now(), options.projectId);
        if (!work) break;
        try {
          const event = this.store.getEvent(work.eventId);
          if (options.projectId && event?.projectId !== options.projectId) {
            this.store.retryWork(work.id, work.claimToken!, 1_000); result.retried++; continue;
          }
          if (event && this.proposeWorkflowRestore(event)) result.proposed++;
          result.skipped++;
          this.store.completeWork(work.id, work.claimToken!);
          result.processed++;
        } catch {
          this.store.retryWork(work.id, work.claimToken!, Math.min(60_000, 1_000 * 2 ** Math.min(work.attempts, 6)));
          result.retried++;
        }
      }
    } finally { this.running = false; }
    return result;
  }
  tick(options: { projectId?: string; limit?: number } = {}): Promise<LearningTickResult> { return this.processPending(options); }

  private proposeWorkflowRestore(event: LearningEvent): boolean {
    const workflows = this.options.workflows;
    if (!workflows || event.kind !== "workflow-step" || event.outcome !== "failed" || !event.workflowId || !event.stepId) return false;
    const current = workflows.get(event.workflowId);
    if (!current || current.revision !== event.workflowRevision || event.projectId !== learningProjectId(current.target || current.id)) return false;
    const runs = workflows.listExecutions(current.id);
    const failures = runs.filter(run => run.workflowRevision === current.revision && run.status === "failed" && run.nodeResults[event.stepId!]?.status === "failed");
    if (new Set(failures.map(run => run.id)).size < 3) return false;
    const baseline = runs.find(run => run.status === "completed" && run.workflowRevision < current.revision && workflowRestorePolicy(run.workflow) === workflowRestorePolicy(current));
    if (!baseline || !workflows.getVersion(current.id, baseline.workflowRevision)) return false;
    const prose = (workflow: typeof current) => JSON.stringify({ name: workflow.name, instructions: workflow.instructions,
      nodes: workflow.nodes.map(node => ({ label: node.label, instructions: node.execution?.instructions })) });
    if (prose(baseline.workflow) === prose(current)) return false;
    const failedIds = new Set(failures.slice(0, 3).map(run => run.id));
    const evidence = this.store.listEvents({projectId: event.projectId, limit: 200}).filter(item => item.workflowId === current.id
      && (item.executionId === baseline.id && item.kind === "workflow-run" && item.outcome === "completed"
        || item.executionId && failedIds.has(item.executionId) && item.kind === "workflow-step" && item.stepId === event.stepId && item.outcome === "failed"));
    if (!evidence.some(item => item.executionId === baseline.id) || new Set(evidence.filter(item => item.outcome === "failed").map(item => item.executionId)).size < 3) return false;
    // Fixed host-written prose: failure text never becomes executable instructions.
    const proposal = JSON.stringify({ action: "restore-workflow-instructions", workflowId: current.id, fromRevision: current.revision,
      restoreRevision: baseline.workflowRevision, failedStepId: event.stepId, failedRuns: 3,
      summary: `This step failed in three runs. Version ${baseline.workflowRevision} finished successfully. Try its earlier instructions?` });
    return Boolean(this.store.createWorkflowSuggestion({projectId: event.projectId, kind: "workflow-restore", targetId: current.id,
      baseVersion: String(current.revision), proposal, evidenceEventIds: evidence.slice(0, 64).map(item => item.id)}));
  }

  /** Mirror actual controller-owned registry state; never promote or reinterpret fixture tests as exploit proofs. */
  mirrorEvolutionRun(projectId: string, config: EvolutionConfig, _result?: EvolutionRunResult): ImprovementCandidate[] {
    const registryPath = resolve(config.storePath);
    const registry = loadEvolutionRegistry(registryPath);
    const mirrored: ImprovementCandidate[] = [];
    for (const version of registry.versions.slice(-100)) {
      if (!version.parentId || version.status === "baseline") continue; // Baselines are not learned improvements.
      verifyEvolutionSnapshot(version.snapshot);
      const parent = registry.versions.find(entry => entry.id === version.parentId);
      if (!parent) throw new Error("Learning registry candidate has no baseline.");
      verifyEvolutionSnapshot(parent.snapshot);
      const proposalPath = join(receiptsDir(registryPath), `${version.id}.proposal.json`);
      if (version.proposalDigest && evolutionDigest(readEvolutionArtifact(proposalPath)) !== version.proposalDigest)
        throw new Error("Learning registry proposal digest mismatch.");
      const receipt = loadEvolutionReceipt(registryPath, version.id);
      if (version.receiptDigest && !receipt) throw new Error("Learning registry evaluation receipt is missing.");
      if (receipt && (receipt.receiptDigest !== version.receiptDigest || receipt.candidateDigest !== version.snapshot.digest
        || receipt.baselineDigest !== parent.snapshot.digest || receipt.configDigest !== version.configDigest
        || receipt.decision.candidateId !== version.id)) throw new Error("Learning registry receipt identity mismatch.");
      if ((version.status === "active" || version.status === "canary") && (!receipt || receipt.decision.status === "rejected"))
        throw new Error("Active learning registry candidate needs a passing controller receipt.");
      if (version.status === "active" && registry.activeId !== version.id) throw new Error("Active learning registry pointer mismatch.");
      const event = this.store.appendEvent({ projectId, idempotencyKey: `evolution:${evolutionDigest(registryPath)}:${version.id}`,
        kind: "artifact-evaluation", outcome: "recorded", evidenceStrength: "operational", summary: "The evolution controller recorded a versioned artifact and output-fixture evaluation. This does not establish verified security capability.",
        evidenceRefs: [version.id, ...(version.proposalDigest ? [proposalPath] : []), ...(receipt ? [join(receiptsDir(registryPath), `${version.id}.json`)] : [])], evidenceDigests: [version.snapshot.digest, ...(version.proposalDigest ? [version.proposalDigest] : []), ...(receipt ? [receipt.receiptDigest] : [])] });
      const status = version.status === "candidate" ? receipt?.decision.status === "rejected" ? "rejected" : "proposed" : version.status;
      mirrored.push(this.store.mirrorRegistryCandidate({ projectId, kind: version.kind, targetId: evolutionDigest(registryPath),
        baseVersion: parent.id, proposal: JSON.stringify({ kind: version.kind, versionId: version.id, snapshotDigest: version.snapshot.digest, parentId: parent.id, proposalDigest: version.proposalDigest ?? null }), evidenceEventIds: [event.id],
        registry: { registryVersionId: version.id, registryStorePath: registryPath, snapshotDigest: version.snapshot.digest, registryStatus: version.status } }, status,
        receipt ? [{ suiteDigest: receipt.configDigest, baselineDigest: receipt.baselineDigest, candidateDigest: receipt.candidateDigest,
          evaluatorDigest: receipt.result.evaluatorDigestBefore, evaluationKind: "output-fixture", passed: receipt.decision.status !== "rejected",
          outcome: receipt.decision.status === "rejected" ? "failed" : "passed", metrics: {
            baselineDevelopmentSuccess: receipt.result.development.champion.successRate,
            candidateDevelopmentSuccess: receipt.result.development.challenger.successRate,
            baselineHeldOutSuccess: receipt.result.heldOut.champion.successRate,
            candidateHeldOutSuccess: receipt.result.heldOut.challenger.successRate,
          } }] : []));
    }
    return mirrored;
  }

  async evaluate(candidateId: string, projectId?: string): Promise<ImprovementCandidate> {
    if (!this.options.evaluator) throw new Error("Learning evaluation is not configured. Configure a trusted server-side evaluator first.");
    const original = this.store.getCandidate(candidateId);
    if (!original || (projectId && original.projectId !== projectId)) throw new Error("Learning candidate not found.");
    if (this.evaluating.has(candidateId)) throw new Error("Learning candidate is already evaluating.");
    if (original.status !== "proposed") throw new Error("Only a proposed candidate can be evaluated.");
    const candidate = this.store.transitionCandidate(original.id, original.revision, "evaluating");
    this.evaluating.add(candidateId);
    const controller = new AbortController();
    const timeoutMs = Math.min(300_000, Math.max(100, this.options.evaluationTimeoutMs ?? 60_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        this.options.evaluator.evaluate(structuredClone(candidate), { signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Learning evaluation timed out.")); }, timeoutMs); }),
      ]);
      if (receipt.candidateDigest !== candidate.artifactDigest) throw new Error("Evaluation receipt does not match the frozen candidate artifact.");
      if (!receipt.evaluatorDigest || !/^sha256:[a-f0-9]{64}$/i.test(receipt.evaluatorDigest) || !/^sha256:[a-f0-9]{64}$/i.test(receipt.suiteDigest)) throw new Error("Evaluation requires a frozen suite and evaluator identity.");
      if (receipt.candidateId !== candidate.id) throw new Error("Evaluation receipt belongs to another candidate.");
      return this.store.recordEvaluation(candidate.id, candidate.revision, receipt);
    } catch (cause) {
      const current = this.store.getCandidate(candidate.id);
      if (current?.status === "evaluating") this.store.transitionCandidate(current.id, current.revision, "rejected");
      throw cause;
    } finally { if (timer) clearTimeout(timer); this.evaluating.delete(candidateId); }
  }
}
