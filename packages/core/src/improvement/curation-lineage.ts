import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ValidationFixture } from "../stages/lens-synthesis/types.js";
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
/** One explicit conversion contract. No arbitrary unapproved expected-answer mapping. */
export function evolutionSourceFixtureCase(id: string, lane: EvolutionCase["lane"], fixture: ValidationFixture): EvolutionCase {
  const fd = openSync(fixture.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let source: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error("canonical source-fixture conversion requires one bounded regular file");
    const bytes = readFileSync(fd);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.length !== stat.size || digest !== fixture.contentDigest) throw new Error("approved fixture bytes changed during conversion");
    source = bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("canonical source-fixture conversion requires UTF-8 source");
  } finally { closeSync(fd); }
  if (lane !== "negative-control" && (!fixture.expectedCwe || !fixture.expectedFile || (!fixture.expectedLine && !fixture.expectedRange))) throw new Error("approved positive fixture expected identity is incomplete");
  return { id, lane, input: { format: "source-fixture-v1", file: basename(fixture.path), source },
    expected: { findings: lane === "negative-control" ? [] : [{ cwe: fixture.expectedCwe!, file: fixture.expectedFile!,
      ...(fixture.expectedLine === undefined ? {} : { line: fixture.expectedLine }), ...(fixture.expectedRange === undefined ? {} : { range: fixture.expectedRange }) }] } };
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
    return [id, { observation, corpus }] as const;
  }));
  return selected.map(fixture => {
    const reference = fixture.curation!;
    const { observation, corpus } = observations.get(reference.observationId)!;
    const cohort = fixture.lane === "development" ? corpus.positives : fixture.lane === "held-out" ? corpus.heldOut : corpus.negativeControls;
    const approvedFixture = cohort.find(entry => entry.contentDigest === reference.fixtureDigest);
    if (evolutionObservationApprovalIdentity(observation) !== reference.approvalDigest
      || !approvedFixture) {
      throw new Error("curated fixture approval or content lineage differs");
    }
    const canonicalCase = evolutionSourceFixtureCase(fixture.id, fixture.lane, approvedFixture!);
    if (evolutionCaseContentIdentity(canonicalCase) !== evolutionCaseContentIdentity(fixture)) {
      throw new Error("case input/expected outputs differ from independently approved canonical fixture conversion");
    }
    return { caseDigest: evolutionCaseContentIdentity(fixture), observationId: observation.id,
      approvalDigest: reference.approvalDigest, fixtureDigest: reference.fixtureDigest,
      sourceRevisionDigest: observation.sourceRevisionDigest };
  }).sort((a, b) => a.caseDigest.localeCompare(b.caseDigest));
}
