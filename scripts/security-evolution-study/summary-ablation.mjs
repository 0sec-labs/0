import { readFileSync } from 'node:fs';
import { digest, admitCorpus } from './corpus.mjs';
import { admitProtocol, analyzeStudy } from './protocol.mjs';
import { runPreregisteredStudy } from './run.mjs';

export function preregisterSummaryAblation(protocol, corpus) {
  admitCorpus(corpus); admitProtocol(protocol, corpus);
  const study = { schemaVersion: 1, study: 'development-summary-ablation-121', implementation: { driver: digest(readFileSync(new URL('./summary-ablation.mjs', import.meta.url))), summary: digest(readFileSync(new URL('../../packages/core/dist/improvement/development-summary.js', import.meta.url))) }, baselineProtocolDigest: protocol.protocolDigest, corpusDigest: corpus.digest, arms: ['current-feedback', 'compact-summary'], proposalWidth: 1, parentSelection: 'same frozen baseline', editableSurface: protocol.editableSurface, proposalsPerArm: protocol.proposalCalls, campaignBudgetUsdPerArm: protocol.budgetUsd, sharedCampaignBudgetUsd: 2 * protocol.budgetUsd, maximumCallsPerArm: protocol.maxCalls, finalReserveUsdPerArm: protocol.finalReservedUsd, summaryLimits: { maxCases: 20, maxObservations: 100, maxExamplesPerGroup: 2, maxBytes: 4096, maxTokens: 4096, maxCachedReceipts: 2 }, summaryModelCalls: 0, seed: protocol.seed, alpha: protocol.analysis.alpha, stopPolicy: 'retain current feedback on negative/inconclusive result; no combined diversity arm', primaryObjective: 'paired source-oracle quality improvement with no additional false alarms or retention regression under equal declared total search limits', caveat: 'equal maximum spend allocations, not a claim that observed token charges are equal' };
  return { ...study, preregistrationDigest: digest(study) };
}
export async function createCompactFeedbackTransform(limits) {
  const { DevelopmentSummaryCache } = await import('../../packages/core/dist/improvement/development-summary.js');
  const cache = new DevelopmentSummaryCache(limits);
  return feedback => {
    const observations = feedback.filter(row => row.lane === 'development').map(row => ({
      attempt: { caseId: row.caseId, lane: 'development', repeat: row.repeat, matched: row.correct, inconclusive: row.outcome === 'inconclusive', costUsd: 0, execution: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false } },
      // Only a trusted source-oracle failure with independently curated positive
      // labels is a detection miss. An inconclusive trace is never vulnerability truth.
      ...(!row.correct && !row.falseAlarm && row.outcome === 'no-finding' ? { adjudication: { category: 'confirmed-detection-miss', verifierReceiptDigest: digest([row.sourceDigest, row.observedFinding, row.correct, row.falseAlarm]) } } : {}),
    }));
    return cache.summarize(observations).prompt;
  };
}

export async function runSummaryAblation({ protocol, corpus, preregistration, mode, providerFactory, ledgerPrefix, approvedSharedBudgetUsd = 0, qualifiedPilotReport = null }) {
  const expected = preregisterSummaryAblation(protocol, corpus);
  if (preregistration.preregistrationDigest !== expected.preregistrationDigest || JSON.stringify(preregistration) !== JSON.stringify(expected)) throw new Error('summary preregistration changed');
  if (mode === 'provider') {
    if (approvedSharedBudgetUsd < preregistration.sharedCampaignBudgetUsd) throw new Error('both arms and final reserves need one approved shared spend cap');
    if (!qualifiedPilotReport || qualifiedPilotReport.conclusion !== 'qualified' || qualifiedPilotReport.mode !== 'provider' || qualifiedPilotReport.protocolDigest !== protocol.protocolDigest || qualifiedPilotReport.cost?.unknownUsage !== false || typeof qualifiedPilotReport.cost?.billedUsd !== 'number' || !qualifiedPilotReport.receipts?.some(r => r.lane === 'final') || qualifiedPilotReport.pairedAnalysis?.regressionDetected !== true) throw new Error('summary execution is gated on qualified model-backed pilot with reconciled billing and validated controls');
  }
  const compact = await createCompactFeedbackTransform(preregistration.summaryLimits);
  const results = {};
  // Common limits and same parent; only development feedback representation varies.
  // Ordinary scans never import this explicit offline driver.
  for (const arm of preregistration.arms) {
    results[arm] = await runPreregisteredStudy({ protocol, corpus, mode, provider: await providerFactory(arm), ledgerPath: ledgerPrefix ? `${ledgerPrefix}.${arm}.ledger.jsonl` : undefined, approvedBudgetUsd: mode === 'provider' ? protocol.budgetUsd : 0, feedbackTransform: arm === 'compact-summary' ? values => compact(values.map(row => ({ ...row, lane: 'development' }))) : values => values, studyTag: `summary-121:${arm}` });
    if (results[arm].cost.unknownUsage) break; // One shared accounting uncertainty stops both arms.
  }
  const raw = results['current-feedback']; const summarized = results['compact-summary'];
  const pairedReceipts = [
    ...(raw?.receipts ?? []).filter(r => r.lane === 'final' && r.arm === 'sequential').map(r => ({ ...r, arm: 'frozen-baseline' })),
    ...(summarized?.receipts ?? []).filter(r => r.lane === 'final' && r.arm === 'sequential'),
    ...(raw?.receipts ?? []).filter(r => r.lane === 'final' && (r.arm === 'aa' || r.arm === 'regression')),
  ];
  const costLedger = preregistration.arms.flatMap(arm => results[arm]?.costLedger ?? []);
  const paired = analyzeStudy(protocol, pairedReceipts, { mode, costLedger, elapsedMs: Object.values(results).reduce((s, r) => s + r.elapsedMs, 0), cpuMs: Object.values(results).reduce((s, r) => s + r.cpuMs, 0), stopReason: summarized ? null : 'shared accounting stop before compact arm' });
  const proposalTokens = arm => {
    const rows = results[arm]?.costLedger.filter(r => r.role === 'proposal') ?? [];
    return rows.every(r => r.usage) ? { input: rows.reduce((s, r) => s + r.usage.inputTokens, 0), output: rows.reduce((s, r) => s + r.usage.outputTokens, 0) } : null;
  };
  return { schemaVersion: 1, study: preregistration.study, preregistrationDigest: preregistration.preregistrationDigest, protocolDigest: protocol.protocolDigest, corpusDigest: corpus.digest, mode, conclusion: 'inconclusive', currentFeedbackRetained: true, broaderEnablement: false, automaticPromotion: false, primaryComparison: { independentFamilies: paired.pairedAnalysis.independentFamilies, meanGain: paired.pairedAnalysis.meanGain, interval95: paired.pairedAnalysis.interval95, retentionRegressions: paired.pairedAnalysis.retentionRegressions }, arms: Object.fromEntries(preregistration.arms.map(arm => [arm, results[arm] ? { quality: results[arm].arms.sequential, controls: { aaDisagreements: results[arm].pairedAnalysis.aaDisagreements, regressionDetected: results[arm].pairedAnalysis.regressionDetected }, cost: results[arm].cost, proposalTokens: proposalTokens(arm), elapsedMs: results[arm].elapsedMs, cpuMs: results[arm].cpuMs } : null])), actualSharedMeteredTariffUsd: costLedger.filter(r => r.state === 'settled').reduce((s, r) => s + (r.meteredTariffUsd ?? 0), 0), invoiceUsd: costLedger.length && costLedger.every(r => typeof r.billedUsd === 'number') ? costLedger.reduce((s, r) => s + r.billedUsd, 0) : null, unknownUsage: costLedger.some(r => r.state !== 'settled'), reasons: paired.reasons, controllerResults: results };
}
