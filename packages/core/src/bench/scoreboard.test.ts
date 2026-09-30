import { describe, it, expect } from "vitest";
import type { BenchScorecard } from "./scorecard.js";
import { wilson95 } from "./scorecard.js";
import type { BenchmarkLedger, LedgerEntry } from "./ledger.js";
import { renderScoreboard, type ScoreboardJson } from "./scoreboard.js";

// ── Synthetic scorecard/ledger builders ───────────────────────────────
//
// The scoreboard is a pure projection of ledger DATA, so we hand-build a few
// scorecards with known headline numbers rather than running the harness.

function makeScorecard(over: {
  manifestId: string;
  verified: number;
  gradeablePositives: number;
  falsePositives: number;
  knownNegatives: number;
  inconclusive?: number;
  costPerSuccessUsd?: number | null;
}): BenchScorecard {
  const successRate =
    over.gradeablePositives === 0 ? 0 : over.verified / over.gradeablePositives;
  const fpRate = over.knownNegatives === 0 ? 0 : over.falsePositives / over.knownNegatives;
  const inconclusive = over.inconclusive ?? 0;
  const cases = over.gradeablePositives + over.knownNegatives + inconclusive;
  return {
    schemaVersion: 1,
    manifestId: over.manifestId,
    config: {
      passAtK: 1,
      attemptPolicy: "pass-at-k",
      maxTurns: 40,
      costCeilingUsd: null,
      ciSubset: false,
    },
    totals: {
      cases,
      positives: over.gradeablePositives + inconclusive,
      knownNegatives: over.knownNegatives,
      verified: over.verified,
      refuted: over.gradeablePositives - over.verified,
      inconclusive,
      attempts: cases,
      verifiedAttempts: over.verified,
      refutedAttempts: over.gradeablePositives - over.verified,
      inconclusiveAttempts: inconclusive,
    },
    successRate,
    successRateCI95: wilson95(over.verified, over.gradeablePositives),
    attemptSuccessRate: successRate,
    attemptSuccessRateCI95: wilson95(over.verified, over.gradeablePositives),
    falsePositives: over.falsePositives,
    fpRate,
    totalCostUsd: 1,
    costPerSuccessUsd: over.costPerSuccessUsd ?? (over.verified === 0 ? null : 0.25),
    totalAttackTurns: 10,
    totalInputTokens: 100,
    totalOutputTokens: 100,
    totalTokens: 200,
    byObjective: {},
    cases: [],
  };
}

function makeLedger(): BenchmarkLedger {
  const entries: LedgerEntry[] = [
    {
      runId: "run-001",
      manifestId: "corpus-v1",
      championId: "champion",
      green: true,
      scorecard: makeScorecard({
        manifestId: "corpus-v1",
        verified: 8,
        gradeablePositives: 10,
        falsePositives: 0,
        knownNegatives: 3,
      }),
    },
    {
      // A red run — a false positive appeared and success dropped.
      runId: "run-002",
      manifestId: "corpus-v1",
      championId: "champion",
      green: false,
      scorecard: makeScorecard({
        manifestId: "corpus-v1",
        verified: 5,
        gradeablePositives: 10,
        falsePositives: 1,
        knownNegatives: 3,
      }),
    },
    {
      // Recovered green run.
      runId: "run-003",
      manifestId: "corpus-v1",
      championId: "champion-b",
      green: true,
      scorecard: makeScorecard({
        manifestId: "corpus-v1",
        verified: 9,
        gradeablePositives: 10,
        falsePositives: 0,
        knownNegatives: 3,
      }),
    },
    {
      // Latest run: success regressed 40pp vs the last green (run-003) → a
      // regression the gate/verdict must catch.
      runId: "run-004",
      manifestId: "corpus-v1",
      championId: "champion-b",
      green: false,
      scorecard: makeScorecard({
        manifestId: "corpus-v1",
        verified: 5,
        gradeablePositives: 10,
        falsePositives: 0,
        knownNegatives: 3,
      }),
    },
  ];
  return { schemaVersion: 1, entries };
}

describe("renderScoreboard — markdown", () => {
  const ledger = makeLedger();
  const { markdown } = renderScoreboard(ledger, { title: "0 public benchmark" });

  it("renders the title and champion", () => {
    expect(markdown).toContain("# 0 public benchmark");
    expect(markdown).toContain("## Champion: `champion-b`");
    expect(markdown).toContain("`run-004`");
    expect(markdown).toContain("`corpus-v1`");
  });

  it("shows the champion success/FP figures with the Wilson interval", () => {
    // latest = run-004: 5/10 = 50.0%, fp 0/3 = 0.0%.
    expect(markdown).toContain("**Success rate:** 50.0%");
    expect(markdown).toContain("(Wilson 95%)");
    expect(markdown).toContain("**False-positive rate:** 0.0% (0/3 known-negatives)");
    expect(markdown).toContain("**Cases:** 13 (5 verified · 5 refuted · 0 inconclusive)");
  });

  it("shows a gate verdict and a regression verdict vs the prior green", () => {
    // Default gate maxFpRate=0, minSuccessRate=0 → passes (fp is 0).
    expect(markdown).toContain("**Gate:** 🟢 GREEN");
    // Regression: 90% (run-003) → 50% is a 40pp drop > default 5pp.
    expect(markdown).toContain("## Regression vs prior green");
    expect(markdown).toContain("🔴 RED");
    expect(markdown).toContain("baseline `run-003`");
    expect(markdown).toContain("success rate regressed");
  });

  it("emits one trend row per ledger entry", () => {
    for (const e of ledger.entries) {
      expect(markdown).toContain(`| \`${e.runId}\` | \`corpus-v1\` |`);
    }
    // Header + separator + 4 data rows.
    const rows = markdown.split("\n").filter((l) => l.startsWith("| "));
    expect(rows.length).toBe(2 + ledger.entries.length);
  });
});

describe("renderScoreboard — JSON shape + stable keys", () => {
  const { json } = renderScoreboard(makeLedger());

  it("has the expected top-level keys in a stable order", () => {
    expect(Object.keys(json)).toEqual([
      "schemaVersion",
      "title",
      "hasData",
      "totalRuns",
      "champion",
      "gate",
      "regression",
      "trend",
    ]);
  });

  it("carries the champion + regression + trend data", () => {
    expect(json.hasData).toBe(true);
    expect(json.totalRuns).toBe(4);
    expect(json.champion?.championId).toBe("champion-b");
    expect(json.champion?.runId).toBe("run-004");
    expect(json.champion?.successRate).toBeCloseTo(0.5, 10);
    expect(json.gate?.passed).toBe(true);
    expect(json.regression?.passed).toBe(false);
    expect(json.regression?.baselineRunId).toBe("run-003");
    expect(json.trend.map((t) => t.runId)).toEqual([
      "run-001",
      "run-002",
      "run-003",
      "run-004",
    ]);
  });

  it("respects keepRuns for the trend slice", () => {
    const { json: j2 } = renderScoreboard(makeLedger(), { keepRuns: 2 });
    expect(j2.trend.map((t) => t.runId)).toEqual(["run-003", "run-004"]);
  });
});

describe("renderScoreboard — determinism + empty ledger", () => {
  it("is byte-stable for the same input", () => {
    const a = renderScoreboard(makeLedger(), { title: "X" });
    const b = renderScoreboard(makeLedger(), { title: "X" });
    expect(a.markdown).toBe(b.markdown);
    expect(JSON.stringify(a.json)).toBe(JSON.stringify(b.json));
  });

  it("handles an empty ledger without a champion", () => {
    const { markdown, json } = renderScoreboard({ schemaVersion: 1, entries: [] });
    expect(json.hasData).toBe(false);
    expect(json.champion).toBeNull();
    expect(json.trend).toEqual([]);
    expect(markdown).toContain("No benchmark runs recorded yet");
  });
});
