/** Trusted explicit offline adapter; creating it performs no provider calls.
 * Proposal calls reuse the existing campaign ledger and source/trust guards.
 * No private evaluation result is returned to the development proposer. */
import { join } from "node:path";
import { canonicalEvolutionJson, parseEvolutionConfig } from "./config.js";
import { evaluateEvolutionCandidate, evolutionComparisonIdentity } from "./evaluation.js";
import { createEvolutionCandidate, evolutionDigest, verifyEvolutionSnapshot } from "./registry.js";
import { EvolutionGenerationError, proposeEvolutionEdits } from "./rewrite.js";
import { ensureEvolutionDirectory, publishEvolutionArtifact } from "./artifacts.js";
import { createEvolutionSandbox } from "./sandbox.js";
import { blockEvolutionCampaign, createOrLoadEvolutionCampaign, reserveCampaignDispatch, settleCampaignDispatch } from "./safety.js";
import type { EvolutionConfig, EvolutionDependencies, EvolutionSnapshot } from "./types.js";
import type { PilotCharge, PilotIdentity } from "../bench/security-evolution-pilot.js";
import type { SearchStudyAdapter, SearchStudyDispatch } from "./paired-search-study.js";

export function createModelSearchStudyAdapter(options: {
  /** Separate independently curated contracts: only development inputs from
   * searchConfig enter proposal context. finalConfig never enters propose(). */
  searchConfig: EvolutionConfig;
  finalConfig: EvolutionConfig;
  baseline: EvolutionSnapshot;
  /** Only integrity/contract-admitted versions; IDs are opaque proposer handles. */
  parents: ReadonlyMap<string, EvolutionSnapshot>;
  dependencies: EvolutionDependencies;
  /** Bind a provider-side token/dollar limit for this explicit dispatch. */
  proposalDependencies: (request: SearchStudyDispatch) => EvolutionDependencies;
  /** Pinned identity observed by the trusted provider adapter, not model text. */
  identity: PilotIdentity;
  /** Independent trusted billing observation. A rate estimate is never an invoice.
   * Return null when provider/provisioner actual billing is not available. */
  observeBilling: (request: SearchStudyDispatch, phase: "proposal" | "development-compute" | "final-compute", estimatedUsd: number) => Promise<{ actualUsd: number | null; receiptDigest: string | null }>;

}): SearchStudyAdapter {
  const search = parseEvolutionConfig(options.searchConfig);
  const final = parseEvolutionConfig(options.finalConfig);
  if (!search.safety?.enabled || !final.safety?.enabled || !final.retentionPolicy || !search.allowModelSourceAccess
    || !options.dependencies.modelIdentity || options.identity.modelVersionStatus !== "pinned"
    || typeof options.proposalDependencies !== "function" || typeof options.observeBilling !== "function") {
    throw new Error("model studies require durable accounting, explicit source consent and host-observed pinned identity");
  }
  const sharedContract = (config: EvolutionConfig) => evolutionDigest({ sourceRoot: config.sourceRoot, sourcePaths: config.sourcePaths,
    editablePaths: config.editablePaths, image: config.image, backend: config.backend ?? "docker", command: config.command,
    buildCommand: config.buildCommand ?? null, timeoutMs: config.timeoutMs, memoryMb: config.memoryMb, cpus: config.cpus,
    workerModel: config.safety?.workerModel ?? null });
  if (sharedContract(search) !== sharedContract(final)) throw new Error("search and final worker/editable contracts differ");
  if (search.storePath === final.storePath) throw new Error("search and independent final require separate authoritative campaign stores");
  const searchInputs = new Set(search.cases.map(c => canonicalEvolutionJson(c.input)));
  if (final.cases.some(c => searchInputs.has(canonicalEvolutionJson(c.input)))) throw new Error("independent final corpus overlaps search inputs");
  verifyEvolutionSnapshot(options.baseline);
  for (const parent of options.parents.values()) verifyEvolutionSnapshot(parent);
  const candidates = new Map<string, EvolutionSnapshot>();
  const trialConfig = (config: EvolutionConfig, request: SearchStudyDispatch): EvolutionConfig => ({ ...config,
    storePath: join(config.storePath, "paired-study", evolutionDigest(request.seed).slice(7), request.arm),
  });
  const operationId = (request: SearchStudyDispatch, phase: string) => `${request.seed}:${request.arm}:${request.ordinal}:${phase}`;
  const receipt = (request: SearchStudyDispatch, phase: string, actualUsd: number | null, category: PilotCharge["category"]): PilotCharge => ({ id: operationId(request, phase), actualUsd, category });
  const snapshot = (id: string) => {
    const value = candidates.get(id);
    if (!value) throw new Error("unrecognized study candidate");
    verifyEvolutionSnapshot(value);
    return value;
  };
  return {
    async propose(request) {
      const parent = options.parents.get(request.parentId);
      if (!parent) throw new Error("unadmitted archive parent");
      verifyEvolutionSnapshot(parent);
      if (parent.files.reduce((sum, file) => sum + file.bytes, 0) + search.maxChangedBytes > request.maxRetainedBytes) throw new Error("retained snapshot reserve cannot cover next proposal");
      const config = trialConfig(search, request);
      const proposalDependencies = options.proposalDependencies(request);
      if (!proposalDependencies.model || !proposalDependencies.modelIdentity) throw new Error("a provider-side budget-bound model callback is required");
      let proposal;
      try {
        proposal = await proposeEvolutionEdits(parent, { ...config, maxModelCostUsd: Math.min(config.maxModelCostUsd, request.ceilingUsd) }, request.feedback, proposalDependencies);
      } catch (error) {
        if (error instanceof EvolutionGenerationError) {
          const observed = error.meteringIncomplete ? null : await options.observeBilling(request, "proposal", error.modelCostUsd);
          const valid = observed && observed.actualUsd !== null && Number.isFinite(observed.actualUsd) && observed.actualUsd >= 0
            && /^sha256:[a-f0-9]{64}$/.test(observed.receiptDigest ?? "");
          const matched = valid && Math.abs(observed.actualUsd! - error.modelCostUsd) <= 1e-9;
          if (!matched) blockEvolutionCampaign(config.storePath, "failed proposal invoice requires reconciliation");
          return { value: null, charges: [receipt(request, "rejected-proposal", valid ? observed.actualUsd : null, "proposal")],
            workerExecutions: 0, retainedBytes: 0, status: matched ? "rejected" : "inconclusive", reason: error.message.slice(0, 1024) };
        }
        throw error;
      }
      const billing = await options.observeBilling(request, "proposal", proposal.modelCostUsd);
      const billingValid = billing.actualUsd !== null && Number.isFinite(billing.actualUsd) && billing.actualUsd >= 0
        && /^sha256:[a-f0-9]{64}$/.test(billing.receiptDigest ?? "");
      publishEvolutionArtifact(join(config.storePath, "receipts", `${operationId(request, "billing").replace(/[^a-zA-Z0-9-]/g, "-")}.json`), { estimatedUsd: proposal.modelCostUsd, ...billing });
      if (!billingValid || Math.abs(billing.actualUsd! - proposal.modelCostUsd) > 1e-9) {
        blockEvolutionCampaign(config.storePath, "proposal invoice unavailable or differs from settled rate estimate; reconcile ledger");
        return { value: null, charges: [receipt(request, "proposal", billingValid ? billing.actualUsd : null, "proposal")], workerExecutions: 0, retainedBytes: 0, status: "inconclusive", reason: "proposal actual billing requires reconciliation" };
      }
      if (!proposal.edits.length) return { value: null, charges: [receipt(request, "proposal", proposal.modelCostUsd, "proposal")], status: "rejected", reason: "no changed artifact", workerExecutions: 0, retainedBytes: 0 };
      ensureEvolutionDirectory(join(config.storePath, "snapshots"));
      const candidate = await createEvolutionCandidate(parent, proposal, config);
      publishEvolutionArtifact(join(config.storePath, "receipts", `${candidate.id}.proposal.json`), proposal);
      const retainedBytes = candidate.files.reduce((sum, file) => sum + file.bytes, 0);
      candidates.set(candidate.id, candidate);
      return { value: { id: candidate.id, digest: candidate.digest, hypothesis: proposal.rationale.slice(0, 2048) || "Bounded generated edit",
        observedFailure: request.feedback.slice(0, 2048) || "Operator-declared development failure",
        changedSurface: proposal.edits.map(edit => edit.path).join(",").slice(0, 2048), risk: "Generated source requires independent authority, negative-control and retention validation" },
        charges: [receipt(request, "proposal", proposal.modelCostUsd, "proposal")], workerExecutions: 0, retainedBytes, status: "ok" };
    },
    async build(request) {
      snapshot(request.candidate.id);
      // Existing sandbox executes buildCommand inside each bounded worker;
      // no duplicate unmetered host build is launched here.
      return { value: true, charges: [receipt(request, "materialization", 0, "build")], workerExecutions: 0, retainedBytes: 0, status: "ok" };
    },
    async development(request) {
      const config = trialConfig(search, request);
      const candidate = snapshot(request.candidate.id);
      const fixtures = config.cases.filter(c => c.lane === "development");
      const executions = fixtures.length * config.repeats;
      const worker = config.safety!.workerModel;
      const maximumCompute = config.timeoutMs / 1000 * config.computeUsdPerSecond;
      if (executions !== request.maxWorkerExecutions || executions * (maximumCompute + (worker?.maxCostUsdPerExecution ?? 0)) > request.ceilingUsd) {
        throw new Error("development ceiling cannot cover complete declared execution panel");
      }
      createOrLoadEvolutionCampaign(config.storePath, evolutionComparisonIdentity(config, options.dependencies.modelIdentity!()), "paired-development", config);
      const sandbox = options.dependencies.sandbox ?? createEvolutionSandbox(config);
      const charges: PilotCharge[] = [];
      let matched = 0;
      let dispatched = 0;
      for (let repeat = 0; repeat < config.repeats; repeat++) for (const fixture of fixtures) {
        const computeReservation = reserveCampaignDispatch(config.storePath, "evaluation", maximumCompute);
        let modelReservation: ReturnType<typeof reserveCampaignDispatch> | undefined;
        try {
          if (worker) modelReservation = reserveCampaignDispatch(config.storePath, "model", worker.maxCostUsdPerExecution);
          dispatched++;
          const result = await sandbox({ snapshot: candidate, config, input: fixture.input, signal: options.dependencies.signal });
          const estimatedCompute = Number.isFinite(result.durationMs) && result.durationMs >= 0 && !result.cleanupFailed ? result.durationMs / 1000 * config.computeUsdPerSecond : null;
          const billing = estimatedCompute === null ? null : await options.observeBilling(request, "development-compute", estimatedCompute);
          const computeUsd = billing && billing.actualUsd !== null && Number.isFinite(billing.actualUsd) && billing.actualUsd >= 0
            && /^sha256:[a-f0-9]{64}$/.test(billing.receiptDigest ?? "") ? billing.actualUsd : null;
          settleCampaignDispatch(config.storePath, computeReservation.id, computeUsd, evolutionDigest(result));
          charges.push(receipt(request, `compute-${dispatched}`, computeUsd, "compute"));
          if (worker) {
            const usage = result.workerModelUsage;
            const cost = usage && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 && /^sha256:[a-f0-9]{64}$/.test(usage.receiptDigest) ? usage.costUsd : null;
            settleCampaignDispatch(config.storePath, modelReservation!.id, cost, usage?.receiptDigest ?? null);
            charges.push(receipt(request, `model-${dispatched}`, cost, "worker-model"));
            if (!usage || usage.provider !== worker.provider || usage.model !== worker.model || cost === null || cost > worker.maxCostUsdPerExecution) {
              blockEvolutionCampaign(config.storePath, "unknown or incompatible development worker usage");
              return { value: null, charges, workerExecutions: dispatched, retainedBytes: 0, status: "inconclusive", reason: "development worker provenance/cost requires reconciliation" };
            }
          } else if (result.workerModelUsage) {
            const usage = result.workerModelUsage;
            const cost = Number.isFinite(usage.costUsd) && usage.costUsd >= 0 && /^sha256:[a-f0-9]{64}$/.test(usage.receiptDigest) ? usage.costUsd : null;
            charges.push(receipt(request, `undeclared-model-${dispatched}`, cost, "worker-model"));
            blockEvolutionCampaign(config.storePath, "undeclared development model charge");
            return { value: null, charges, workerExecutions: dispatched, retainedBytes: 0, status: "inconclusive", reason: "undeclared model charge requires reconciliation" };
          }
          if (computeUsd !== null && computeUsd > maximumCompute) {
            blockEvolutionCampaign(config.storePath, "development compute exceeded dispatch reservation");
            return { value: null, charges, workerExecutions: dispatched, retainedBytes: 0, status: "inconclusive", reason: "development compute ceiling exceeded" };
          }
          if (computeUsd === null || result.exitCode !== 0 || result.timedOut || result.error) return { value: null, charges, workerExecutions: dispatched, retainedBytes: 0, status: "inconclusive", reason: "development execution did not complete" };
          try { if (canonicalEvolutionJson(JSON.parse(result.stdout)) === canonicalEvolutionJson(fixture.expected)) matched++; } catch { /* malformed output remains a failed development example */ }
        } catch (error) {
          settleCampaignDispatch(config.storePath, computeReservation.id, null);
          if (modelReservation) settleCampaignDispatch(config.storePath, modelReservation.id, null);
          charges.push(receipt(request, `unknown-execution-${dispatched}`, null, "compute"));
          return { value: null, charges, workerExecutions: dispatched, retainedBytes: 0, status: "inconclusive", reason: `development execution requires reconciliation: ${error instanceof Error ? error.message.slice(0, 512) : "unknown"}` };
        }
      }
      const score = matched / executions;
      return { value: { score, feedback: canonicalEvolutionJson({ protocol: "development-match-summary-v1", matched, executions }) }, charges, workerExecutions: dispatched, retainedBytes: 0, status: "ok" };
    },
    async final(request) {
      // All seeds/arms share one authoritative final ledger. Repeated final
      // queries consume one finite exposure budget instead of resetting per arm.
      const config = final;
      createOrLoadEvolutionCampaign(config.storePath, evolutionComparisonIdentity(config, options.dependencies.modelIdentity!()), "paired-independent-final", config);
      const candidate = snapshot(request.candidate.id);
      const executions = config.cases.length * config.repeats * 2;
      const perExecution = config.timeoutMs / 1000 * config.computeUsdPerSecond + (config.safety?.workerModel?.maxCostUsdPerExecution ?? 0);
      if (executions !== request.maxWorkerExecutions || executions * perExecution > request.ceilingUsd) throw new Error("final reserve cannot cover complete independent evaluation");
      // Final has a distinct corpus/ledger so no development call discloses or
      // consumes the independent panel. It never returns to proposal feedback.
      const evaluation = await evaluateEvolutionCandidate(options.baseline, candidate, { ...config, maxEvaluationCostUsd: request.ceilingUsd }, options.dependencies);
      publishEvolutionArtifact(join(config.storePath, "receipts", `${candidate.id}.final.json`), evaluation);
      const attempts = [...evaluation.attempts.baseline, ...evaluation.attempts.candidate];
      const estimatedCompute = attempts.reduce((sum, attempt) => sum + attempt.costUsd - (attempt.execution.workerModelUsage?.costUsd ?? 0), 0);
      const billing = await options.observeBilling(request, "final-compute", estimatedCompute);
      const billingValid = billing.actualUsd !== null && Number.isFinite(billing.actualUsd) && billing.actualUsd >= 0
        && /^sha256:[a-f0-9]{64}$/.test(billing.receiptDigest ?? "");
      if (!billingValid || Math.abs(billing.actualUsd! - estimatedCompute) > 1e-9) {
        blockEvolutionCampaign(config.storePath, "final compute invoice unavailable or differs from settled rate estimate; reconcile ledger");
        return { value: null, charges: [receipt(request, "final-compute", billingValid ? billing.actualUsd : null, "compute"),
          ...attempts.flatMap((attempt, index) => attempt.execution.workerModelUsage ? [receipt(request, `final-model-${index}`, attempt.execution.workerModelUsage.costUsd, "worker-model")] : [])],
          workerExecutions: attempts.length, retainedBytes: 0, status: "inconclusive", reason: "final actual compute billing requires reconciliation" };
      }
      const charges = attempts.flatMap((attempt, index) => {
        const model = attempt.execution.workerModelUsage?.costUsd ?? 0;
        return [receipt(request, `final-compute-${index}`, attempt.costUsd - model, "compute"),
          ...(attempt.execution.workerModelUsage ? [receipt(request, `final-model-${index}`, model, "worker-model")] : [])];
      });
      const actual = evaluation.result.provenance;
      if (actual?.provider !== options.identity.provider || actual.resolvedModel !== options.identity.resolvedModel
        || actual.sourceRevision !== options.identity.sourceDigest || actual.evaluatorDigest !== options.identity.evaluatorDigest) {
        throw new Error("final resolved identity differs from pinned study adapter");
      }
      return { value: { verifiedQuality: evaluation.result.heldOut.challenger.successRate,
        falsePositives: evaluation.attempts.candidate.filter(a => a.lane === "negative-control" && !a.matched && !a.inconclusive).length,
        retentionPassed: evaluation.retention?.passed ?? evaluation.result.ciPassed,
        evidenceValid: attempts.every(a => !a.inconclusive),
        identity: { ...options.identity, harnessDigest: candidate.digest } },
        charges, workerExecutions: attempts.length, retainedBytes: 0, status: "ok" };
    },
  };
}
