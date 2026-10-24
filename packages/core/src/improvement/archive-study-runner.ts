import { selectArchiveStudyParent, type DevelopmentArchiveObservation } from "./archive-study.js";
import { runPairedSearchStudy, type SearchStudyAdapter, type SearchStudyPlan } from "./paired-search-study.js";

/** The caller admits snapshots with admitEvolutionAlternativeParents before
 * creating this development-only projection. No private receipts enter it. */
export async function runArchiveSearchStudy(options: {
  plan: SearchStudyPlan;
  currentId: string;
  observations: DevelopmentArchiveObservation[];
  repeats: number;
  feedback: string;
  adapter: SearchStudyAdapter;
  now?: () => number;
}) {
  const policies = ["current", "uniform", "development-diversity"] as const;
  // Validate every policy before any external dispatch, including each seed.
  for (const seed of options.plan.seeds) for (const policy of policies) {
    selectArchiveStudyParent(options.observations, { policy, seed, currentId: options.currentId, maxCandidates: 10, repeats: options.repeats });
  }
  return runPairedSearchStudy({ plan: options.plan, adapter: options.adapter, now: options.now,
    arms: policies.map(policy => ({ id: policy, width: 1, feedback: options.feedback,
      parentId: seed => selectArchiveStudyParent(options.observations, { policy, seed, currentId: options.currentId, maxCandidates: 10, repeats: options.repeats }),
    })),
  });
}

/** Registry entry point for real studies: no caller-supplied archive admission.
 * Uses existing immutable snapshots, feedback contracts and receipt identities. */
export async function runRegisteredArchiveSearchStudy(options: {
  config: import("./types.js").EvolutionConfig;
  currentEvidenceVersionId: string;
  /** Full initial campaign invoice observation, including rejected attempts.
   * Historical token-rate receipts alone are not actual spend evidence. */
  initialArchiveBilling: { actualUsd: number; receiptDigest: string };
  plan: SearchStudyPlan;
  feedback: string;
  /** Called only after all archived parents and current evidence are admitted. */
  createAdapter: (parents: ReadonlyMap<string, import("./types.js").EvolutionSnapshot>) => SearchStudyAdapter;
}) {
  const [{ loadEvolutionRegistry, loadEvolutionReceipt, evolutionDigest, verifyEvolutionSnapshot, receiptsDir }, { admitEvolutionAlternativeParents }, { evolutionEvaluatorDigest }, { readEvolutionArtifact }, { join }] = await Promise.all([
    import("./registry.js"), import("./loop.js"), import("./evaluation.js"), import("./artifacts.js"), import("node:path"),
  ]);
  if (!Number.isFinite(options.initialArchiveBilling?.actualUsd) || options.initialArchiveBilling.actualUsd < 0
    || !/^sha256:[a-f0-9]{64}$/.test(options.initialArchiveBilling.receiptDigest)) throw new Error("initial archive actual billing is unresolved");
  if (!options.config.maxAlternativeParents || options.config.maxAlternativeParents < 1) throw new Error("archive study requires an explicitly enabled bounded archive");
  const registry = loadEvolutionRegistry(options.config.storePath);
  const active = registry.versions.find(version => version.id === registry.activeId);
  if (!active) throw new Error("archive study has no deployment baseline");
  verifyEvolutionSnapshot(active.snapshot);
  const admitted = admitEvolutionAlternativeParents({ ...options.config, maxAlternativeParents: Math.min(9, options.config.maxAlternativeParents) }, registry);
  if (!admitted.length) throw new Error("no compatible older archive parent remains after admission");
  const currentEvidence = loadEvolutionReceipt(options.config.storePath, options.currentEvidenceVersionId);
  if (!currentEvidence || currentEvidence.configDigest !== evolutionDigest(options.config)
    || currentEvidence.result.evaluatorDigestBefore !== evolutionEvaluatorDigest()
    || currentEvidence.result.evaluatorDigestAfter !== evolutionEvaluatorDigest()) throw new Error("current development evidence is absent or incompatible");
  const currentAttempts = currentEvidence.candidateDigest === active.snapshot.digest ? currentEvidence.attempts.candidate
    : currentEvidence.baselineDigest === active.snapshot.digest ? currentEvidence.attempts.baseline : null;
  if (!currentAttempts) throw new Error("current development receipt does not bind active source bytes");
  const parents = new Map([[active.id, active.snapshot], ...admitted.map(entry => [entry.version.id, entry.version.snapshot] as const)]);
  const observations = [{ id: active.id, attempts: currentAttempts.filter(attempt => attempt.lane === "development") },
    ...admitted.map(entry => ({ id: entry.version.id, attempts: entry.attempts }))];
  // Account for the fixed initial archive separately from marginal study spend.
  // Refuse missing history billing rather than presenting it as free.
  let historicalRecordedProposalCostUsd = 0;
  let historicalRecordedEvaluationCostUsd = 0;
  const archiveReceiptDigests = new Set<string>();
  for (const entry of admitted) {
    const receipt = loadEvolutionReceipt(options.config.storePath, entry.version.id)!;
    if (!entry.version.proposalDigest) throw new Error("archive proposal accounting is missing");
    const proposal = readEvolutionArtifact(join(receiptsDir(options.config.storePath), `${entry.version.id}.proposal.json`)) as import("./types.js").EvolutionProposal;
    if (evolutionDigest(proposal) !== entry.version.proposalDigest || !Number.isFinite(proposal.modelCostUsd) || proposal.modelCostUsd < 0) throw new Error("archive proposal accounting is invalid");
    historicalRecordedProposalCostUsd += proposal.modelCostUsd;
    historicalRecordedEvaluationCostUsd += [...receipt.attempts.baseline, ...receipt.attempts.candidate].reduce((sum, attempt) => sum + attempt.costUsd, 0);
    archiveReceiptDigests.add(receipt.receiptDigest);
  }
  if (!archiveReceiptDigests.has(currentEvidence.receiptDigest)) {
    historicalRecordedEvaluationCostUsd += [...currentEvidence.attempts.baseline, ...currentEvidence.attempts.candidate].reduce((sum, attempt) => sum + attempt.costUsd, 0);
    archiveReceiptDigests.add(currentEvidence.receiptDigest);
  }
  const report = await runArchiveSearchStudy({ plan: options.plan, currentId: active.id, observations, repeats: options.config.repeats,
    feedback: options.feedback, adapter: options.createAdapter(parents) });
  return { initialArchive: { observedBilling: options.initialArchiveBilling, archiveReceiptDigests: [...archiveReceiptDigests], historicalRecordedProposalCostUsd, historicalRecordedEvaluationCostUsd,
    accountingScope: "fixed initial archive receipts; earlier ancestors and unsuccessful unrecorded campaigns require separate campaign-ledger accounting" }, report };
}
