import { createHash } from "node:crypto";
import { canonicalEvolutionJson } from "./config.js";
import { getObservation, type LearningObservation } from "../stages/lens-synthesis/feedback.js";
import { prepareValidationCorpus } from "../stages/lens-synthesis/validate.js";
import type { EvolutionCase, EvolutionConfig } from "./types.js";
const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalEvolutionJson(value)).digest("hex")}`;
export function evolutionCaseContentIdentity(fixture: EvolutionCase): string {
  return hash({ lane: fixture.lane, input: fixture.input, expected: fixture.expected });
}
/** Stable approval semantics, excluding operational claim/processing timestamps. */
export function evolutionObservationApprovalIdentity(observation: LearningObservation): string {
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(observation.sourceRevisionDigest)) throw new Error("approved observation source byte identity is unavailable");
  if (!observation.consent || !["approved", "processed"].includes(observation.status) || !observation.approvedShape) {
    throw new Error("evolution fixture requires an independently approved observation");
  }
  return hash({ id: observation.id, sourceRevisionDigest: observation.sourceRevisionDigest, approvedShape: observation.approvedShape });
}
/** Validated once per explicit contract. No raw observations/expected outputs enter receipts. */
export function evolutionCurationLineage(config: EvolutionConfig) {
  const selected = config.cases.filter(entry => entry.curation);
  if (!selected.length) return [];
  if (!config.observationStorePath) throw new Error("curated fixtures require an authoritative observation store");
  const ids = [...new Set(selected.map(entry => entry.curation!.observationId))];
  if (ids.length > 64) throw new Error("curation contract exceeds 64 independent observations");
  const observations = new Map(ids.map(id => {
    const observation = getObservation(id, { storePath: config.observationStorePath });
    if (!observation) throw new Error("curated observation is unavailable");
    evolutionObservationApprovalIdentity(observation);
    // Reuse the authoritative symlink/content/clean-control validation, including
    // stored fixture-content stamps. Changed/deleted fixture files are stale.
    const shape = observation.approvedShape!;
    const corpus = prepareValidationCorpus(shape);
    return [id, { observation, fixtures: [...corpus.positives, ...corpus.heldOut, ...corpus.negativeControls] }] as const;
  }));
  return selected.map(fixture => {
    const reference = fixture.curation!;
    const { observation, fixtures } = observations.get(reference.observationId)!;
    if (evolutionObservationApprovalIdentity(observation) !== reference.approvalDigest
      || !fixtures.some(entry => entry.contentDigest === reference.fixtureDigest)) {
      throw new Error("curated fixture approval or content lineage differs");
    }
    return { caseDigest: evolutionCaseContentIdentity(fixture), observationId: observation.id,
      approvalDigest: reference.approvalDigest, fixtureDigest: reference.fixtureDigest,
      sourceRevisionDigest: observation.sourceRevisionDigest };
  }).sort((a, b) => a.caseDigest.localeCompare(b.caseDigest));
}
