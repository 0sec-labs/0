import { describe, it, expect } from "vitest";

import { parseManifest, type BenchManifest } from "../bench/manifest.js";
import type { BenchScan, BenchScanInput } from "../bench/runner.js";
import type { BenchScanResult } from "../bench/oracle.js";
import { runTournament } from "../bench/tournament.js";
import type { BenchVariant } from "../bench/variant.js";
import { emptyLedger, appendLedgerEntry, type LedgerEntry } from "../bench/ledger.js";
import { captureLensCandidates } from "../stages/lens-synthesis/miss-capture.js";
import type { LensSynthesisInput, ValidationCorpus } from "../stages/lens-synthesis/types.js";

import {
  harvestMissesFromScorecard,
  harvestMissesFromTournament,
  harvestMissesFromLedgerEntry,
  harvestedMissesToMissInput,
  mergeHarvestedMisses,
} from "./miss-harvest.js";

// A synthetic corpus with a known false-negative, a champion pass, a
// known-negative, and a non-finding-match (web) case.
const MANIFEST: BenchManifest = parseManifest({
  id: "flywheel-corpus",
  cases: [
    {
      id: "sqli-miss",
      target: { kind: "source-audit", package: "acme-orm", version: "1.2.3", ecosystem: "npm" },
      objective: { type: "finding-match", vulnClass: "sql-injection", sinkMarkers: ["lib/query.js", "buildWhere"] },
    },
    {
      id: "xss-pass",
      target: { kind: "source-audit", package: "acme-view", version: "0.9.0", ecosystem: "npm" },
      objective: { type: "finding-match", vulnClass: "xss", sinkMarkers: ["render.js"] },
    },
    {
      id: "sqli-negative",
      knownNegative: true,
      target: { kind: "source-audit", package: "safe-orm", version: "4.0.0", ecosystem: "npm" },
      objective: { type: "finding-match", vulnClass: "sql-injection", sinkMarkers: ["safe.js"] },
    },
    {
      id: "web-fileread",
      target: { kind: "web", image: "ghcr.io/x/y:pinned" },
      objective: { type: "file-read", marker: "FLAG-abc123" },
    },
  ],
});

// Deterministic scan: only xss-pass surfaces its expected in-class finding.
const scan: BenchScan = async (input: BenchScanInput): Promise<BenchScanResult> => {
  if (input.case.id === "xss-pass") {
    return {
      findings: [{ category: "xss", confidence: 0.95, evidence: { analysis: "reflected sink in render.js" } }],
    };
  }
  return { findings: [] };
};

const variantScan = (_v: BenchVariant): BenchScan => scan;

async function runChampion() {
  return runTournament(MANIFEST, { variants: [{ id: "champ" }], variantScan });
}

describe("miss-harvest connector", () => {
  it("harvests only the champion's positive finding-match false-negatives", async () => {
    const tournament = await runChampion();
    const result = harvestMissesFromTournament(tournament, MANIFEST);

    // Exactly one miss: the refuted positive finding-match case.
    expect(result.harvestedCaseIds).toEqual(["sqli-miss"]);
    expect(result.misses).toHaveLength(1);

    const [miss] = result.misses;
    expect(miss.classHint).toBe("sql-injection");
    expect(miss.sinkPattern).toBe("lib/query.js | buildWhere");
    expect(miss.file).toBe("npm:acme-orm@1.2.3");
    expect(miss.whyMissed).toContain("champ");
    expect(miss.whyMissed).toContain("false negative");

    // The case the champion PASSED is NOT harvested.
    expect(result.harvestedCaseIds).not.toContain("xss-pass");
    const skipReason = (id: string) => result.skipped.find((s) => s.caseId === id)?.reason;
    expect(skipReason("xss-pass")).toBe("champion-passed");
    expect(skipReason("sqli-negative")).toBe("known-negative");
    expect(skipReason("web-fileread")).toBe("not-finding-match");
  });

  it("emits the exact MissInput shape lens-synth stage-1 accepts", async () => {
    const tournament = await runChampion();
    const result = harvestMissesFromTournament(tournament, MANIFEST);
    const missInput = harvestedMissesToMissInput(result);

    expect(missInput).toEqual({ confirmedMisses: result.misses });

    // The real lens-synth normalizer must accept it without throwing and
    // preserve the confirmed-miss provenance.
    const candidates = captureLensCandidates(missInput);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("confirmed-miss");
    expect(candidates[0].classHint).toBe("sql-injection");
    expect(candidates[0].exampleFileLine).toBe("npm:acme-orm@1.2.3");
    expect(candidates[0].sinkPattern).toBe("lib/query.js | buildWhere");

    // It composes into a full, well-typed LensSynthesisInput once an operator
    // supplies the (gated) corpus — the connector never fabricates the corpus.
    const corpus: ValidationCorpus = {
      positives: [{ id: "p1", path: "/tmp/pos", expectedCwe: "CWE-89" }],
      negativeControls: [{ id: "n1", path: "/tmp/neg" }],
      heldOut: [{ id: "h1", path: "/tmp/held", expectedCwe: "CWE-89" }],
    };
    const full: LensSynthesisInput = { misses: missInput, corpus };
    expect(full.misses.confirmedMisses).toHaveLength(1);
  });

  it("harvests equivalently from a ledger entry and a raw scorecard", async () => {
    const tournament = await runChampion();
    const scorecard = tournament.variants[0].scorecard;

    const fromScorecard = harvestMissesFromScorecard(scorecard, MANIFEST, "champ");

    const ledger = appendLedgerEntry(emptyLedger(), {
      runId: "run-1",
      manifestId: MANIFEST.id,
      championId: "champ",
      scorecard,
      green: true,
    } satisfies LedgerEntry);
    const fromLedger = harvestMissesFromLedgerEntry(ledger.entries[0], MANIFEST);

    expect(fromLedger.misses).toEqual(fromScorecard.misses);
    expect(fromLedger.championId).toBe("champ");
  });

  it("mergeHarvestedMisses is idempotent (union, de-duped)", async () => {
    const tournament = await runChampion();
    const { misses } = harvestMissesFromTournament(tournament, MANIFEST);

    const once = mergeHarvestedMisses({ confirmedMisses: [] }, misses);
    const twice = mergeHarvestedMisses(once, misses);
    expect(once.confirmedMisses).toHaveLength(1);
    expect(twice.confirmedMisses).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it("throws when the named champion is absent from the tournament", async () => {
    const tournament = await runChampion();
    const corrupt = { ...tournament, championId: "ghost" };
    expect(() => harvestMissesFromTournament(corrupt, MANIFEST)).toThrow(/champion "ghost"/);
  });
});
