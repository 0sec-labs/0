// Pure offline aggregation. A retained-artifact union is never a single-run score.
import { createHash } from 'node:crypto';
const sorted = (values) => [...new Set(values)].sort();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const money = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const mode = (value) => value === true ? 'white-box' : value === false ? 'black-box' : 'unknown';

export function aggregateXbowReports(inputs) {
  const cohorts = new Map();
  const coverage = { 'black-box': new Set(), 'white-box': new Set(), unknown: new Set() };
  const sources = { 'black-box': Object.create(null), 'white-box': Object.create(null), unknown: Object.create(null) };
  const seenReports = new Set();
  for (const { report, source } of inputs) {
    if (!report || !Array.isArray(report.results)) throw new Error('XBOW report requires results array');
    const reportDigest = digest(report);
    const sourceKey = JSON.stringify([source, reportDigest]);
    if (seenReports.has(sourceKey)) continue; // Same physical report supplied twice is not another run.
    seenReports.add(sourceKey);
    for (const result of report.results) {
      if (!result || typeof result.id !== 'string' || !result.id || typeof result.flagFound !== 'boolean') {
        throw new Error('XBOW result requires id and boolean flagFound');
      }
      const policy = {
        configuredModel: text(report.model), selectedModel: text(result.model) ?? text(report.model),
        mode: mode(result.whiteBox ?? report.whiteBox), runtime: text(report.runtime), runnerMode: text(report.mode),
        retries: positive(report.retries),
        repeatN: report.repeatProtocol === undefined ? 1 : positive(report.repeatProtocol?.N),
        repeatCostCeilingUsd: money(report.repeatProtocol?.costCeilingUsd),
        observedAttempts: result.attempts === undefined ? (Array.isArray(result.perRun) ? positive(result.perRun.length) : report.repeatProtocol === undefined ? 1 : null) : positive(result.attempts),
        costCeilingHit: result.costCeilingHit === true,
      };
      // Report/source identity prevents cross-run best-of selection, even when
      // visible model/mode settings match. Shards are NOT assumed independent.
      const identity = { source, reportDigest, ...policy };
      const key = digest(identity);
      let cohort = cohorts.get(key);
      if (!cohort) {
        cohort = { id: key, ...identity, rows: [], seen: new Set(), duplicates: new Set() };
        cohorts.set(key, cohort);
      }
      if (cohort.seen.has(result.id)) cohort.duplicates.add(result.id);
      cohort.seen.add(result.id);
      cohort.rows.push(result);
      if (result.flagFound) {
        coverage[policy.mode].add(result.id);
        (sources[policy.mode][result.id] ??= []).push({ ...source, reportDigest, cohortId: key, ...policy });
      }
    }
  }
  const summaries = [...cohorts.values()].map(({ rows, seen, duplicates, ...identity }) => {
    const solved = sorted(rows.filter(r => r.flagFound).map(r => r.id));
    const unknownPolicy = identity.retries === null || identity.repeatN === null || identity.observedAttempts === null;
    const ensemble = identity.configuredModel?.includes(',') || identity.runtime?.includes('best-of-');
    const singleAttemptPolicy = unknownPolicy ? null : identity.retries === 1 && identity.repeatN === 1 && identity.observedAttempts === 1 && !ensemble && duplicates.size === 0;
    let knownCost = 0, costRows = 0;
    for (const row of rows) {
      let cost = null;
      if (Array.isArray(row.perRun) && row.perRun.length === identity.observedAttempts && row.perRun.every(r => money(r.cost) !== null)) {
        cost = row.perRun.reduce((sum, r) => sum + r.cost, 0);
      } else if (identity.observedAttempts !== null && money(row.meanCostUsd) !== null && row.attempts !== undefined) {
        cost = row.meanCostUsd * identity.observedAttempts;
      } else if (identity.observedAttempts === 1) cost = money(row.estimatedCostUsd);
      if (cost !== null && Number.isFinite(cost)) { knownCost += cost; costRows++; }
    }
    return { ...identity, aggregation: 'within-report-any-success', singleAttemptPolicy,
      singleRunClaimVerified: false,
      // Artifacts do not by themselves establish hidden model retries, substrate,
      // turn caps, or independent trial provenance. Never generate that claim.
      attempted: seen.size, solved: solved.length, resultRows: rows.length,
      repeatedChallengeIds: sorted(duplicates), challengeIds: sorted(seen), challengesSolved: solved,
      reportedRatePct: seen.size ? Math.round(solved.length / seen.size * 1000) / 10 : 0,
      knownCostUsd: costRows ? knownCost : null, costRows, missingCostRows: rows.length - costRows,
      totalCostUsd: costRows === rows.length && identity.retries === 1 && !ensemble && duplicates.size === 0 ? knownCost : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const blackBox = sorted(coverage['black-box']), whiteBox = sorted(coverage['white-box']), unknownMode = sorted(coverage.unknown);
  const aggregate = sorted([...blackBox, ...whiteBox, ...unknownMode]);
  const whiteBoxOnly = whiteBox.filter(id => !coverage['black-box'].has(id));
  return { schemaVersion: 2, aggregation: 'retained-artifact-union', singleRunClaimVerified: false,
    counts: { blackBox: blackBox.length, whiteBox: whiteBox.length, unknownMode: unknownMode.length, aggregate: aggregate.length, whiteBoxOnly: whiteBoxOnly.length },
    solved: { blackBox, whiteBox, unknownMode, aggregate, whiteBoxOnly }, sources, cohorts: summaries };
}
