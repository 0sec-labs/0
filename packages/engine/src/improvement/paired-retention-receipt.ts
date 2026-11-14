/** Controller-owned bridge from existing immutable evaluation receipts, not model summaries. */
import { evolutionDigest } from "./registry.js";
import type { EvolutionComparisonIdentity } from "./safety.js";
import type { EvolutionEvaluation } from "./types.js";
import type { PairedRetentionObservation } from "./paired-retention.js";
const immutable = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
export interface PairedRetentionChargeEvidence { caseId: string; repeat: number; actualCostUsd: number; receiptDigest: string }
export interface PairedRetentionPanelCase { caseId: string; capabilityId: string; familyDigest: string }
/** Proposal model and changed harness artifact bytes are intentionally distinct
 * from the pinned evaluated-worker/evaluator/corpus comparison contract. */
export function pairedRetentionComparisonDigest(identity: EvolutionComparisonIdentity): string {
  const worker = identity.evaluatedWorker;
  if (!worker || [identity.sourceRevision, identity.toolRevision, identity.harnessRevision, identity.evaluatorDigest, identity.evaluatorSemantics].some(v => !immutable(v))
    || (worker.kind === "model" && (worker.revision.status !== "pinned" || !worker.revision.revision || !immutable(worker.revision.decodingDigest)))) {
    throw new Error("paired retention requires pinned actual worker/evaluator/source identity");
  }
  return evolutionDigest({ source: identity.sourceRevision, tool: identity.toolRevision, harness: identity.harnessRevision,
    evaluator: identity.evaluatorDigest, semantics: identity.evaluatorSemantics,
    development: identity.development, heldOut: identity.heldOut, negativeControl: identity.negativeControl, worker });
}
export function pairedRetentionObservationsFromReceipt(
  evaluation: EvolutionEvaluation, generationId: string, panel: readonly PairedRetentionPanelCase[],
  invariants: { authorityPreserved: boolean; evidenceCorrect: boolean },
  charges?: { baseline: readonly PairedRetentionChargeEvidence[]; candidate: readonly PairedRetentionChargeEvidence[] },
): PairedRetentionObservation[] {
  const { receiptDigest, ...unsigned } = evaluation;
  if (evolutionDigest(unsigned) !== receiptDigest) throw new Error("paired retention receipt integrity mismatch");
  if (!panel.length || panel.length > 1000 || new Set(panel.map(p => p.caseId)).size !== panel.length
    || panel.some(p => !p.caseId || !p.capabilityId || !immutable(p.familyDigest))) throw new Error("invalid controller-owned sealed retention panel");
  const identity = evaluation.comparisonIdentity ?? evaluation.result.provenance;
  if (!identity) throw new Error("paired retention receipt comparison identity unavailable");
  const comparisonDigest = pairedRetentionComparisonDigest(identity);
  const baseline = new Map<string, EvolutionEvaluation["attempts"]["baseline"][number]>();
  const candidate = new Map<string, EvolutionEvaluation["attempts"]["candidate"][number]>();
  for (const [entries, target] of [[evaluation.attempts.baseline, baseline], [evaluation.attempts.candidate, candidate]] as const) {
    for (const entry of entries) {
      const key = `${entry.caseId}:${entry.repeat}`;
      if (target.has(key) || !Number.isSafeInteger(entry.repeat) || entry.repeat < 0) throw new Error("duplicate or invalid receipt execution pair");
      target.set(key, entry);
    }
  }
  const chargeMaps = new Map<"baseline" | "candidate", Map<string, PairedRetentionChargeEvidence>>();
  for (const side of ["baseline", "candidate"] as const) {
    const map = new Map<string, PairedRetentionChargeEvidence>();
    for (const charge of charges?.[side] ?? []) {
      const key = `${charge.caseId}:${charge.repeat}`;
      if (map.has(key) || !immutable(charge.receiptDigest) || !Number.isFinite(charge.actualCostUsd) || charge.actualCostUsd < 0) throw new Error("invalid authoritative paired charge evidence");
      map.set(key, charge);
    }
    chargeMaps.set(side, map);
  }
  return panel.flatMap(fixture => {
    const repeats = new Set([...evaluation.attempts.baseline, ...evaluation.attempts.candidate].filter(e => e.caseId === fixture.caseId).map(e => e.repeat));
    if (!repeats.size) repeats.add(0); // Missing panel evidence is retained as an inconclusive pair.
    return [...repeats].sort((a, b) => a - b).map(repeat => {
      const before = baseline.get(`${fixture.caseId}:${repeat}`), after = candidate.get(`${fixture.caseId}:${repeat}`);
      if ([before, after].some(entry => entry?.lane === "development") || (before && after && before.lane !== after.lane)) throw new Error("paired retention panel must contain matching sealed lanes");
      const side = (entry: typeof before, variant: "baseline" | "candidate") => ({ succeeded: entry?.matched === true && !entry.inconclusive,
        falsePositive: entry?.lane === "negative-control" && !entry.inconclusive && !entry.matched,
        // Existing evaluator totals contain duration/tariff estimates. Do not
        // relabel them as provider invoices; require explicit host reconciliation.
        costUsd: entry ? chargeMaps.get(variant)!.get(`${fixture.caseId}:${repeat}`)?.actualCostUsd ?? null : null,
        ...(entry ? { estimatedCostUsd: entry.costUsd } : {}),
        ...(chargeMaps.get(variant)!.has(`${fixture.caseId}:${repeat}`) ? { billingReceiptDigest: chargeMaps.get(variant)!.get(`${fixture.caseId}:${repeat}`)!.receiptDigest } : {}), latencyMs: entry?.execution.durationMs ?? null, executed: Boolean(entry) });
      return { generationId, capabilityId: fixture.capabilityId, familyDigest: fixture.familyDigest,
        pairDigest: evolutionDigest({ receiptDigest, caseId: fixture.caseId, repeat }), comparisonDigest,
        baseline: side(before, "baseline"), candidate: side(after, "candidate"), inconclusive: !before || !after || before.inconclusive || after.inconclusive,
        ...invariants };
    });
  });
}
