import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  compareEvolutionIdentities,
  createOrLoadEvolutionCampaign,
  createEvolutionComparisonIdentity,
  evolutionCorpusIdentity,
  loadEvolutionCampaign,
  reserveCampaignDispatch,
  reserveHoldoutExposure,
  settleCampaignDispatch,
} from "./safety.js";
import type { EvolutionConfig } from "./types.js";

const roots: string[] = [];
const config = (cases: EvolutionConfig["cases"]): EvolutionConfig => ({
  schemaVersion: 1, sourceRoot: "/tmp/source", storePath: "/tmp/store", image: "sha256:" + "a".repeat(64),
  sourcePaths: ["src"], editablePaths: ["src/worker.js"], kind: "source", command: ["node", "worker.js"],
  cases, repeats: 2, maxIterations: 1, maxModelTurns: 1, maxModelCostUsd: 5, maxEvaluationCostUsd: 5,
  computeUsdPerSecond: 0.001, timeoutMs: 1000, memoryMb: 128, cpus: 1, maxOutputBytes: 1024,
  maxSourceBytes: 4096, maxChangedBytes: 1024, objective: "test", allowModelSourceAccess: false,
  autoPromote: false, canaryTrials: 1, promotionPolicy: { minimumCases: 1, minimumDevelopmentLift: 0, minimumHeldOutLift: 0, maximumNegativeControlFpDelta: 1, maximumCostMultiplier: 2 },
});
const cases = [
  { id: "dev-original", lane: "development" as const, input: { n: 1 }, expected: { ok: true } },
  { id: "holdout-original", lane: "held-out" as const, input: { n: 2 }, expected: { ok: true } },
  { id: "negative-original", lane: "negative-control" as const, input: { n: 3 }, expected: { ok: false } },
];

function freshRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "0sec-evolution-safety-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("evolution safety contract", () => {
  it("keeps corpus identity when only case IDs are renamed", () => {
    const original = evolutionCorpusIdentity(cases);
    const renamed = evolutionCorpusIdentity(cases.map((entry) => ({ ...entry, id: `renamed-${entry.id}` })));
    expect(renamed).toEqual(original);
  });

  it("marks changed evaluator/model provenance incomparable", () => {
    const first = createEvolutionComparisonIdentity(config(cases), "sha256:" + "1".repeat(64), { resolvedModel: "model-a", provider: "provider-a" });
    const second = createEvolutionComparisonIdentity(config(cases), "sha256:" + "2".repeat(64), { resolvedModel: "model-b", provider: "provider-b" });
    const comparison = compareEvolutionIdentities(first, second);
    expect(comparison.status).toBe("incompatible");
    expect(comparison.reasons).toEqual(expect.arrayContaining(["evaluator implementation differs", "resolved model differs"]));
  });

  it("persists unknown-cost blocking across a reload", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity({ ...config(cases), storePath: root }, "sha256:" + "3".repeat(64));
    createOrLoadEvolutionCampaign(root, identity, "renamed-campaign");
    const reservation = reserveCampaignDispatch(root, "model", 1);
    settleCampaignDispatch(root, reservation.id, null);
    expect(loadEvolutionCampaign(root).unknownCost).toBe(true);
    expect(() => reserveCampaignDispatch(root, "model", 1)).toThrow(/blocked/);
  });

  it("consumes holdout exposure and rejects exhaustion without a reset", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity({ ...config(cases), storePath: root }, "sha256:" + "4".repeat(64));
    createOrLoadEvolutionCampaign(root, identity);
    reserveHoldoutExposure(root, identity, 2, 3);
    expect(() => reserveHoldoutExposure(root, identity, 2, 3)).toThrow(/exhausted/);
    expect(loadEvolutionCampaign(root).exposures[0]?.consumed).toBe(2);
  });
});
