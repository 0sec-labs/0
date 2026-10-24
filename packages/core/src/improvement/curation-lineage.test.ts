import { mkdtempSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { captureObservation, approveObservation } from "../stages/lens-synthesis/feedback.js";
import { evolutionCaseContentIdentity, evolutionCurationLineage, evolutionObservationApprovalIdentity, evolutionSourceFixtureCase } from "./curation-lineage.js";
import type { EvolutionConfig } from "./types.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "0-curation-lineage-")); roots.push(root);
  const storePath = join(root, "observations.json");
  const paths = ["positive.js", "heldout.js", "negative.js"].map(name => join(root, name));
  paths.forEach((path, index) => writeFileSync(path, `// distinct curator fixture ${index}\nconsole.log(${index});\n`));
  const observation = captureObservation({ classHint: "CWE-79", sinkPattern: "html", exampleFileLine: "source:1", whyMissed: "observed miss",
    source: "confirmed-miss", scanId: "fixture-scan", sourceRevisionDigest: "sha256:" + "e".repeat(64), consent: true }, { storePath });
  const approve = () => approveObservation(observation.id, {
    positives: [{ id: "positive", path: paths[0]!, expectedCwe: "CWE-79", expectedFile: "positive.js", expectedLine: 1 }],
    heldOut: [{ id: "heldout", path: paths[1]!, expectedCwe: "CWE-79", expectedFile: "heldout.js", expectedLine: 1 }],
    negativeControls: [{ id: "negative", path: paths[2]!, cleanProvenance: "operator-reviewed fixed safe control" }],
  }, { storePath });
  const fixture = { id: "private-holdout", lane: "held-out" as const, input: { fixture: "independent-curated-input" }, expected: { detected: true } };
  return { root, storePath, paths, observation, approve, fixture };
}
describe("approved observation to evaluation fixture lineage", () => {
  it("rejects pending observations as expected-answer authority", () => {
    const { observation } = setup();
    expect(() => evolutionObservationApprovalIdentity(observation)).toThrow(/independently approved/);
  });
  it("traces approval and immutable fixture bytes without putting sealed answers in receipts", () => {
    const { storePath, approve, paths } = setup(); const approved = approve();
    const fixture = evolutionSourceFixtureCase("private-holdout", "held-out", approved.approvedShape!.heldOut[0]!);
    const curation = { observationId: approved.id, approvalDigest: evolutionObservationApprovalIdentity(approved), fixtureDigest: approved.approvedShape!.heldOut[0]!.contentDigest! };
    const config = { observationStorePath: storePath, cases: [{ ...fixture, curation }] } as EvolutionConfig;
    const lineage = evolutionCurationLineage(config);
    expect(lineage).toEqual([{ caseDigest: evolutionCaseContentIdentity(fixture), ...curation, sourceRevisionDigest: approved.sourceRevisionDigest }]);
    const encoded = JSON.stringify(lineage);
    expect(encoded).not.toContain(fixture.id); expect(encoded).not.toContain("distinct curator fixture"); expect(encoded).not.toContain("CWE-79");
    expect(evolutionCurationLineage({ ...config, cases: [{ ...fixture, id: "renamed", curation }] })).toEqual(lineage);
    writeFileSync(paths[1]!, "changed or deleted original source is stale\n");
    expect(() => evolutionCurationLineage(config)).toThrow(/digest mismatch/);
  });
  it("rejects modified case bytes, expected answers and cross-lane approval laundering", () => {
    const { storePath, approve } = setup(); const approved = approve();
    const fixture = evolutionSourceFixtureCase("private-holdout", "held-out", approved.approvedShape!.heldOut[0]!);
    const curation = { observationId: approved.id, approvalDigest: evolutionObservationApprovalIdentity(approved), fixtureDigest: approved.approvedShape!.heldOut[0]!.contentDigest! };
    const config = { observationStorePath: storePath, cases: [{ ...fixture, curation }] } as EvolutionConfig;
    expect(() => evolutionCurationLineage({ ...config, cases: [{ ...fixture, expected: { findings: [] }, curation }] })).toThrow(/canonical fixture conversion/);
    expect(() => evolutionCurationLineage({ ...config, cases: [{ ...fixture, input: { source: "arbitrary unapproved source" }, curation }] })).toThrow(/canonical fixture conversion/);
    expect(() => evolutionCurationLineage({ ...config, cases: [{ ...fixture, curation: { ...curation, fixtureDigest: approved.approvedShape!.negativeControls[0]!.contentDigest! } }] })).toThrow(/lineage differs/);
  });
  it("preflights a bounded complete curated corpus before reading fixture payloads", () => {
    const { storePath, approve, paths } = setup(); const approved = approve();
    const fixture = evolutionSourceFixtureCase("private-holdout", "held-out", approved.approvedShape!.heldOut[0]!);
    const curation = { observationId: approved.id, approvalDigest: evolutionObservationApprovalIdentity(approved), fixtureDigest: approved.approvedShape!.heldOut[0]!.contentDigest! };
    truncateSync(paths[1]!, 65 * 1024 * 1024);
    expect(() => evolutionCurationLineage({ observationStorePath: storePath, cases: [{ ...fixture, curation }] } as EvolutionConfig)).toThrow(/totaling at most 64 MiB/);
  });
  it("rejects substituted approval evidence and unknown fixture content", () => {
    const { storePath, approve, fixture } = setup(); const approved = approve();
    expect(() => evolutionCurationLineage({ observationStorePath: storePath, cases: [{ ...fixture, curation: {
      observationId: approved.id, approvalDigest: "sha256:" + "0".repeat(64), fixtureDigest: approved.approvedShape!.heldOut[0]!.contentDigest!,
    } }] } as EvolutionConfig)).toThrow(/lineage differs/);
  });
});
