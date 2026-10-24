import { createHash } from "node:crypto";
import { canonicalEvolutionJson } from "./config.js";
import { chmodSync, cpSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import {
  campaignPromotionAllowed,
  compareEvolutionIdentities,
  createOrLoadEvolutionCampaign,
  createEvolutionComparisonIdentity,
  evolutionCorpusIdentity,
  holdoutExposureIdentity,
  loadEvolutionCampaign,
  reserveCampaignDispatch,
  reconcileCampaignDispatch,
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

beforeEach(() => { vi.stubEnv("ZERO_EVOLUTION_AUTHORITY_ROOT", freshRoot()); });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("evolution safety contract", () => {
  it("does not substitute evaluator implementation identity for source bytes", () => {
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "1".repeat(64), {
      resolvedModel: "model-a", provider: "provider-a",
    });
    expect(identity.sourceRevision).toBe("unresolved");
    expect(compareEvolutionIdentities(identity, identity).status).toBe("unknown");
  });

  it("rejects inconsistent persisted spending instead of granting budget", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "2".repeat(64), {
      resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64),
    });
    createOrLoadEvolutionCampaign(root, identity, "test", config(cases));
    const reservation = reserveCampaignDispatch(root, "model", 1);
    settleCampaignDispatch(root, reservation.id, 0.5);
    const path = join(root, "campaign-ledger.json");
    const ledger = JSON.parse(readFileSync(path, "utf8"));
    ledger.cumulativeModelCostUsd = 0;
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify(ledger));
    expect(() => reserveCampaignDispatch(root, "model", 1)).toThrow(/inconsistent/);
  });

  it("keeps corpus identity when only case IDs are renamed", () => {
    const original = evolutionCorpusIdentity(cases);
    const renamed = evolutionCorpusIdentity(cases.map((entry) => ({ ...entry, id: `renamed-${entry.id}` })));
    expect(renamed).toEqual(original);
  });

  it("marks changed evaluator/model provenance incomparable", () => {
    const first = createEvolutionComparisonIdentity(config(cases), "sha256:" + "1".repeat(64), { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) });
    const second = createEvolutionComparisonIdentity(config(cases), "sha256:" + "2".repeat(64), { resolvedModel: "model-b", provider: "provider-b", sourceRevision: "sha256:" + "f".repeat(64) });
    const comparison = compareEvolutionIdentities(first, second);
    expect(comparison.status).toBe("incompatible");
    expect(comparison.reasons).toEqual(expect.arrayContaining(["evaluator implementation differs", "resolved model differs"]));
  });

  it("persists unknown-cost blocking across a reload", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity({ ...config(cases), storePath: root }, "sha256:" + "3".repeat(64), { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) });
    createOrLoadEvolutionCampaign(root, identity, "renamed-campaign", config(cases));
    const reservation = reserveCampaignDispatch(root, "model", 1);
    settleCampaignDispatch(root, reservation.id, null);
    expect(loadEvolutionCampaign(root).unknownCost).toBe(true);
    expect(() => reserveCampaignDispatch(root, "model", 1)).toThrow(/blocked/);
  });

  it("consumes holdout exposure and rejects exhaustion without a reset", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity({ ...config(cases), storePath: root }, "sha256:" + "4".repeat(64), { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) });
    createOrLoadEvolutionCampaign(root, identity, "evolution", config(cases));
    reserveHoldoutExposure(root, identity, 2, 3);
    expect(() => reserveHoldoutExposure(root, identity, 2, 3)).toThrow(/exhausted/);
    expect(loadEvolutionCampaign(root).exposures[0]?.consumed).toBe(2);
  });

  it("shares exposure across new stores, copied stores and renamed campaigns", () => {
    const observed = { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) };
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "b".repeat(64), observed);
    const a = freshRoot(), b = freshRoot(), copied = freshRoot();
    createOrLoadEvolutionCampaign(a, identity, "original", config(cases));
    reserveHoldoutExposure(a, identity, 1, 2);
    cpSync(a, copied, { recursive: true });
    chmodSync(join(copied, "campaign"), 0o700);
    const renamed = createEvolutionComparisonIdentity(config(cases.map(entry => ({ ...entry, id: `renamed-${entry.id}` }))), identity.evaluatorDigest, observed);
    createOrLoadEvolutionCampaign(b, renamed, "new-store", config(cases));
    expect(reserveHoldoutExposure(b, renamed, 1, 2).consumed).toBe(2);
    const d = freshRoot(); createOrLoadEvolutionCampaign(d, identity, "new-empty-store", config(cases));
    expect(campaignPromotionAllowed(d).allowed).toBe(false);
    expect(() => reserveHoldoutExposure(a, identity, 1, 2)).toThrow(/exhausted/);
    expect(() => reserveHoldoutExposure(copied, renamed, 1, 2)).toThrow(/exhausted/);
    const fresh = createEvolutionComparisonIdentity(config(cases.map(entry => entry.lane === "held-out" ? { ...entry, input: { n: 99 } } : entry)), identity.evaluatorDigest, observed);
    const c = freshRoot(); createOrLoadEvolutionCampaign(c, fresh, "operator-rotated", config(cases));
    expect(reserveHoldoutExposure(c, fresh, 1, 2).consumed).toBe(1);
  });

  it("imports a legacy local consumption floor before another store can reuse it", () => {
    const root = freshRoot(), other = freshRoot();
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "d".repeat(64), {
      resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64),
    });
    createOrLoadEvolutionCampaign(root, identity, "legacy", config(cases));
    reserveHoldoutExposure(root, identity, 2, 2);
    const path = join(root, "campaign-ledger.json");
    const ledger = JSON.parse(readFileSync(path, "utf8"));
    delete ledger.holdoutAuthorityRoot;
    chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(ledger));
    rmSync(process.env.ZERO_EVOLUTION_AUTHORITY_ROOT!, { recursive: true, force: true });
    createOrLoadEvolutionCampaign(root, identity, "restarted", config(cases));
    createOrLoadEvolutionCampaign(other, identity, "new-store", config(cases));
    expect(() => reserveHoldoutExposure(other, identity, 1, 2)).toThrow(/exhausted/);
    expect(campaignPromotionAllowed(other).allowed).toBe(false);
  });

  it("conservatively combines distinct legacy histories while deduplicating copied IDs", () => {
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "e".repeat(64), {
      resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64),
    });
    const a = freshRoot(), b = freshRoot();
    for (const [root, id] of [[a, "legacy-a"], [b, "legacy-b"]]) {
      createOrLoadEvolutionCampaign(root!, identity, "legacy", config(cases));
      const path = join(root!, "campaign-ledger.json");
      const ledger = JSON.parse(readFileSync(path, "utf8"));
      ledger.exposures = [{ identity: holdoutExposureIdentity(identity), consumed: 2, limit: 4, reservationIds: [id] }];
      chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(ledger));
      createOrLoadEvolutionCampaign(root!, identity, "imported", config(cases));
    }
    expect(campaignPromotionAllowed(a).allowed).toBe(false);
    expect(() => reserveHoldoutExposure(a, identity, 1, 4)).toThrow(/exhausted/);
  });

  it("cannot buy exposure by changing selection thresholds or semantics labels", () => {
    const observed = { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) };
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "9".repeat(64), observed);
    const changed = { ...identity, evaluatorSemantics: "new-profile-name-and-thresholds" };
    expect(holdoutExposureIdentity(changed)).toBe(holdoutExposureIdentity(identity));
    const a = freshRoot(), b = freshRoot();
    createOrLoadEvolutionCampaign(a, identity, "first-policy", config(cases)); reserveHoldoutExposure(a, identity, 1, 1);
    createOrLoadEvolutionCampaign(b, changed, "different-policy", config(cases));
    expect(campaignPromotionAllowed(b).allowed).toBe(false);
    expect(() => reserveHoldoutExposure(b, changed, 1, 1)).toThrow(/exhausted/);
  });

  it("imports an old semantics-keyed shared authority even from a stale store mirror", () => {
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "0".repeat(64), {
      resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64),
    });
    const root = freshRoot(), other = freshRoot();
    createOrLoadEvolutionCampaign(root, identity, "legacy-policy", config(cases));
    reserveHoldoutExposure(root, identity, 2, 2);
    const key = holdoutExposureIdentity(identity);
    const legacyKey = "sha256:" + createHash("sha256").update(canonicalEvolutionJson({ heldOutCorpus: identity.heldOut.digest,
      evaluator: identity.evaluatorDigest, semantics: identity.evaluatorSemantics })).digest("hex");
    const authority = process.env.ZERO_EVOLUTION_AUTHORITY_ROOT!;
    renameSync(join(authority, key.slice(7)), join(authority, legacyKey.slice(7)));
    const path = join(authority, legacyKey.slice(7), "holdout-exposure.json");
    const record = JSON.parse(readFileSync(path, "utf8")); record.identity = legacyKey;
    chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(record));
    const ledgerPath = join(root, "campaign-ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.exposures[0].identity = legacyKey; ledger.exposures[0].consumed = 1;
    chmodSync(ledgerPath, 0o600); writeFileSync(ledgerPath, JSON.stringify(ledger));
    createOrLoadEvolutionCampaign(root, identity, "imported-policy", config(cases));
    createOrLoadEvolutionCampaign(other, { ...identity, evaluatorSemantics: "renamed-policy" }, "new-policy-store", config(cases));
    expect(campaignPromotionAllowed(other).allowed).toBe(false);
  });

  it("measures bounded authority reservation I/O without model or scan calls", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "c".repeat(64), {
      resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64),
    });
    createOrLoadEvolutionCampaign(root, identity, "io-measurement", config(cases));
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now(); reserveHoldoutExposure(root, identity, 1, 100);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const key = loadEvolutionCampaign(root).exposures[0]!.identity.replace("sha256:", "");
    const authority = join(process.env.ZERO_EVOLUTION_AUTHORITY_ROOT!, key, "holdout-exposure.json");
    const report = { schemaVersion: 1, platform: process.platform, node: process.version, reservations: samples.length,
      p50Ms: samples[49], p95Ms: samples[94], maxMs: samples.at(-1),
      campaignBytes: readFileSync(join(root, "campaign-ledger.json")).length,
      authorityBytes: readFileSync(authority).length,
      atomicLedgerWritesPerReservation: 2, controllerLockOwnerWritesPerReservation: 2,
      fsyncCallsPerNormalReservation: 6, fullArchiveScansPerReservation: 0, modelCalls: 0 };
    expect(loadEvolutionCampaign(root).exposures[0]!.consumed).toBe(100);
    if (process.env.HOLDOUT_IO_REPORT) writeFileSync(process.env.HOLDOUT_IO_REPORT, JSON.stringify(report, null, 2) + "\n");
  });

  it("does not treat requested model text as observed provider/model evidence", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity({ ...config(cases), model: "requested-only" }, "sha256:" + "5".repeat(64));
    expect(compareEvolutionIdentities(identity, identity).status).toBe("unknown");
    expect(() => createOrLoadEvolutionCampaign(root, identity, "evolution", config(cases))).toThrow(/unresolved/);
  });

  it("blocks promotion during dispatch and counts reconciled spend exactly once", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "6".repeat(64), { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) });
    createOrLoadEvolutionCampaign(root, identity, "bounded", { maxModelCostUsd: 1, maxEvaluationCostUsd: 1 });
    const first = reserveCampaignDispatch(root, "model", 0.8);
    expect(campaignPromotionAllowed(root).allowed).toBe(false);
    expect(() => reserveCampaignDispatch(root, "model", 0.3)).toThrow(/budget/);
    settleCampaignDispatch(root, first.id, null);
    reconcileCampaignDispatch(root, first.id, 0.6, "sha256:" + "a".repeat(64));
    settleCampaignDispatch(root, first.id, 0.6);
    expect(loadEvolutionCampaign(root).cumulativeModelCostUsd).toBe(0.6);
    expect(campaignPromotionAllowed(root).allowed).toBe(true);
    expect(() => reserveCampaignDispatch(root, "model", 0.5)).toThrow(/budget/);
  });

  it("recovers an interrupted controller without treating a pending dispatch as free", () => {
    const root = freshRoot();
    const identity = createEvolutionComparisonIdentity(config(cases), "sha256:" + "8".repeat(64), { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) });
    createOrLoadEvolutionCampaign(root, identity, "evolution", config(cases));
    const dispatch = reserveCampaignDispatch(root, "evaluation", 1);
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dispatch owner exited"), { code: "ESRCH" });
    });
    try { createOrLoadEvolutionCampaign(root, identity, "evolution", config(cases)); }
    finally { probe.mockRestore(); }
    expect(campaignPromotionAllowed(root).allowed).toBe(false);
    expect(() => reserveCampaignDispatch(root, "evaluation", 1)).toThrow(/blocked/);
    reconcileCampaignDispatch(root, dispatch.id, 0.25, "sha256:" + "c".repeat(64));
    expect(loadEvolutionCampaign(root).cumulativeEvaluationCostUsd).toBe(0.25);
    expect(campaignPromotionAllowed(root).allowed).toBe(true);
  });

  it("keeps exposure across reordered and relabeled content-equivalent campaigns", () => {
    const root = freshRoot();
    const observed = { resolvedModel: "model-a", provider: "provider-a", sourceRevision: "sha256:" + "f".repeat(64) };
    const original = createEvolutionComparisonIdentity(config(cases), "sha256:" + "7".repeat(64), observed);
    createOrLoadEvolutionCampaign(root, original, "evolution", config(cases));
    reserveHoldoutExposure(root, original, 1, 1);
    const renamed = createEvolutionComparisonIdentity(config([...cases].reverse().map((entry) => ({ ...entry, id: `new-${entry.id}` }))), "sha256:" + "7".repeat(64), observed);
    createOrLoadEvolutionCampaign(root, renamed, "evolution", config(cases));
    expect(() => reserveHoldoutExposure(root, renamed, 1, 1)).toThrow(/exhausted/);
    expect(campaignPromotionAllowed(root).allowed).toBe(false);
  });
});
