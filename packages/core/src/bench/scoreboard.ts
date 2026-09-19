/**
 * Benchmark scoreboard — the "benchmark in public" report layer (0sec#656).
 *
 * This turns an existing {@link BenchmarkLedger} into a PUBLISHABLE artifact:
 * a clean GitHub-flavored markdown report plus a stable-key JSON document for a
 * webpage/dashboard. It does NOT run a benchmark and touches no I/O — it is a
 * pure projection of ledger/scorecard DATA, so it is trivially snapshot-testable
 * and diff-friendly when the markdown is committed to a repo file.
 *
 * Determinism: no clock, no fs, no `Date.now()`. Output depends only on the
 * ledger and `opts`, so the same input always renders byte-identical bytes.
 */

import type { BenchScorecard } from "./scorecard.js";
import { evaluateGate, type GateResult, type GateThresholds } from "./scorecard.js";
import {
  emptyLedger,
  evaluateRegression,
  lastGreen,
  type BenchmarkLedger,
  type LedgerEntry,
  type RegressionThresholds,
} from "./ledger.js";

const DEFAULT_TITLE = "0sec benchmark scoreboard";
const DEFAULT_KEEP_RUNS = 10;

export interface RenderScoreboardOptions {
  /** Report title/header. Default "0sec benchmark scoreboard". */
  title?: string;
  /** How many trailing ledger entries to show in the trend table. Default 10. */
  keepRuns?: number;
  /** Regression thresholds forwarded to {@link evaluateRegression}. */
  thresholds?: RegressionThresholds;
  /** Gate thresholds forwarded to {@link evaluateGate} for the champion verdict. */
  gateThresholds?: GateThresholds;
}

/** A single row of the trend table / trend array — the compact per-run slice. */
export interface ScoreboardTrendPoint {
  runId: string;
  manifestId: string;
  championId: string;
  successRate: number;
  fpRate: number;
  cases: number;
  green: boolean;
}

/** The champion (latest ledger entry) headline block. */
export interface ScoreboardChampion {
  runId: string;
  manifestId: string;
  championId: string;
  green: boolean;
  successRate: number;
  successRateCI95: [number, number];
  fpRate: number;
  falsePositives: number;
  knownNegatives: number;
  inconclusive: number;
  cases: number;
  verified: number;
  refuted: number;
  costPerSuccessUsd: number | null;
}

/** Regression verdict, slimmed for publication (no embedded baseline scorecard). */
export interface ScoreboardRegression {
  passed: boolean;
  reasons: string[];
  baselineRunId: string | null;
  thresholds: RegressionResultThresholds;
}

type RegressionResultThresholds = ReturnType<typeof evaluateRegression>["thresholds"];

/** Dashboard/webpage projection of the scoreboard. Stable key order. */
export interface ScoreboardJson {
  schemaVersion: 1;
  title: string;
  hasData: boolean;
  totalRuns: number;
  champion: ScoreboardChampion | null;
  gate: GateResult | null;
  regression: ScoreboardRegression | null;
  trend: ScoreboardTrendPoint[];
}

export interface ScoreboardRender {
  markdown: string;
  json: ScoreboardJson;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ci95(interval: [number, number]): string {
  return `[${(interval[0] * 100).toFixed(1)}–${(interval[1] * 100).toFixed(1)}%]`;
}

function cost(value: number | null): string {
  return value == null ? "n/a" : `$${value.toFixed(3)}`;
}

function trendPoint(entry: LedgerEntry): ScoreboardTrendPoint {
  const s = entry.scorecard;
  return {
    runId: entry.runId,
    manifestId: entry.manifestId,
    championId: entry.championId,
    successRate: s.successRate,
    fpRate: s.fpRate,
    cases: s.totals.cases,
    green: entry.green,
  };
}

function championBlock(entry: LedgerEntry): ScoreboardChampion {
  const s: BenchScorecard = entry.scorecard;
  return {
    runId: entry.runId,
    manifestId: entry.manifestId,
    championId: entry.championId,
    green: entry.green,
    successRate: s.successRate,
    successRateCI95: s.successRateCI95,
    fpRate: s.fpRate,
    falsePositives: s.falsePositives,
    knownNegatives: s.totals.knownNegatives,
    inconclusive: s.totals.inconclusive,
    cases: s.totals.cases,
    verified: s.totals.verified,
    refuted: s.totals.refuted,
    costPerSuccessUsd: s.costPerSuccessUsd,
  };
}

/**
 * Render a publishable scoreboard from a benchmark ledger.
 *
 * Pure: given the same ledger + options it returns byte-identical markdown and
 * a stable-key JSON object. The "champion" is the most recent ledger entry; the
 * regression verdict compares it against the last green entry BEFORE it (reusing
 * {@link evaluateRegression}); the gate verdict is {@link evaluateGate} over the
 * champion's scorecard.
 */
export function renderScoreboard(
  ledger: BenchmarkLedger,
  opts: RenderScoreboardOptions = {},
): ScoreboardRender {
  const title = opts.title ?? DEFAULT_TITLE;
  const keepRuns = opts.keepRuns ?? DEFAULT_KEEP_RUNS;
  const entries = ledger.entries;

  // Trend: the last `keepRuns` entries, chronological (oldest → newest).
  const trendEntries = keepRuns <= 0 ? [] : entries.slice(Math.max(0, entries.length - keepRuns));
  const trend = trendEntries.map(trendPoint);

  if (entries.length === 0) {
    const json: ScoreboardJson = {
      schemaVersion: 1,
      title,
      hasData: false,
      totalRuns: 0,
      champion: null,
      gate: null,
      regression: null,
      trend: [],
    };
    const markdown = [`# ${title}`, "", "_No benchmark runs recorded yet._", ""].join("\n");
    return { markdown, json };
  }

  const latest = entries[entries.length - 1];
  const champion = championBlock(latest);

  const gate = evaluateGate(latest.scorecard, opts.gateThresholds);

  // Baseline = last green run STRICTLY before the champion, so the champion
  // isn't compared against itself.
  const priorLedger: BenchmarkLedger = {
    schemaVersion: 1,
    entries: entries.slice(0, -1),
  };
  const baseline = lastGreen(priorLedger);
  const regressionResult = evaluateRegression(latest.scorecard, baseline, opts.thresholds);
  const regression: ScoreboardRegression = {
    passed: regressionResult.passed,
    reasons: regressionResult.reasons,
    baselineRunId: regressionResult.baseline?.runId ?? null,
    thresholds: regressionResult.thresholds,
  };

  const json: ScoreboardJson = {
    schemaVersion: 1,
    title,
    hasData: true,
    totalRuns: entries.length,
    champion,
    gate,
    regression,
    trend,
  };

  const markdown = renderMarkdown(title, champion, gate, regression, trend);
  return { markdown, json };
}

function verdictBadge(ok: boolean): string {
  return ok ? "🟢 GREEN" : "🔴 RED";
}

function renderMarkdown(
  title: string,
  champion: ScoreboardChampion,
  gate: GateResult,
  regression: ScoreboardRegression,
  trend: ScoreboardTrendPoint[],
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");

  // ── Champion ──
  lines.push(`## Champion: \`${champion.championId}\``);
  lines.push("");
  lines.push(`- **Run:** \`${champion.runId}\``);
  lines.push(`- **Manifest:** \`${champion.manifestId}\``);
  lines.push(
    `- **Success rate:** ${pct(champion.successRate)} ${ci95(champion.successRateCI95)} (Wilson 95%)`,
  );
  lines.push(
    `- **False-positive rate:** ${pct(champion.fpRate)} (${champion.falsePositives}/${champion.knownNegatives} known-negatives)`,
  );
  lines.push(`- **Inconclusive:** ${champion.inconclusive} of ${champion.cases} cases`);
  lines.push(
    `- **Cases:** ${champion.cases} (${champion.verified} verified · ${champion.refuted} refuted · ${champion.inconclusive} inconclusive)`,
  );
  lines.push(`- **Cost / success:** ${cost(champion.costPerSuccessUsd)}`);
  lines.push(`- **Gate:** ${verdictBadge(gate.passed)}`);
  if (!gate.passed) {
    for (const r of gate.reasons) lines.push(`  - ${r}`);
  }
  lines.push("");

  // ── Regression vs prior green ──
  lines.push("## Regression vs prior green");
  lines.push("");
  const baselineNote = regression.baselineRunId
    ? `baseline \`${regression.baselineRunId}\``
    : "first run — no green baseline";
  lines.push(`- **Verdict:** ${verdictBadge(regression.passed)} (${baselineNote})`);
  if (regression.reasons.length > 0) {
    for (const r of regression.reasons) lines.push(`  - ${r}`);
  }
  lines.push("");

  // ── Trend ──
  lines.push(`## Trend (last ${trend.length} run${trend.length === 1 ? "" : "s"})`);
  lines.push("");
  lines.push("| Run | Manifest | Success | FP | Cases | Gate |");
  lines.push("| --- | --- | ---: | ---: | ---: | :---: |");
  for (const t of trend) {
    lines.push(
      `| \`${t.runId}\` | \`${t.manifestId}\` | ${pct(t.successRate)} | ${pct(t.fpRate)} | ${t.cases} | ${t.green ? "🟢" : "🔴"} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** Convenience: render a scoreboard from an empty ledger (for scaffolding). */
export function renderEmptyScoreboard(opts: RenderScoreboardOptions = {}): ScoreboardRender {
  return renderScoreboard(emptyLedger(), opts);
}
