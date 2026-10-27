import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './security-evolution-study/corpus.mjs';
import { preregister } from './security-evolution-study/protocol.mjs';
import { deterministicControlProvider } from './security-evolution-study/run.mjs';
import { preregisterSummaryAblation, createCompactFeedbackTransform, runSummaryAblation } from './security-evolution-study/summary-ablation.mjs';
function inputs() {
  const cases = [];
  for (const lane of ['development', 'selection', 'final']) for (const label of ['vulnerable', 'fixed', 'clean']) { const source = `${lane}:${label}:__proto__`; cases.push({ id: digest(source), family: `${lane}-${label}`, lane, label, source, sourceDigest: digest(source), sinks: ['__proto__'], advisory: 'fixture', tarballIntegrity: 'sha512-fixture' }); }
  const data = { schemaVersion: 1, advisories: [{ id: 'fixture' }], cases }; const corpus = { ...data, digest: digest(data) }; const protocol = preregister(corpus); return { corpus, protocol, preregistration: preregisterSummaryAblation(protocol, corpus) };
}
test('summary preregisters equal proposal width, budget, parent, final reserve and no model summarizer', () => {
  const { protocol, preregistration } = inputs();
  assert.equal(preregistration.sharedCampaignBudgetUsd, 2 * protocol.budgetUsd);
  assert.equal(preregistration.proposalWidth, 1); assert.equal(preregistration.summaryModelCalls, 0);
  assert.equal(preregistration.finalReserveUsdPerArm, protocol.finalReservedUsd);
});
test('compact feedback uses bounded existing development-only summary without raw findings or case identities', async () => {
  const { preregistration } = inputs(); const transform = await createCompactFeedbackTransform(preregistration.summaryLimits);
  const feedback = [{ caseId: 'DEV-IDENTITY', lane: 'development', repeat: 0, sourceDigest: digest('source'), outcome: 'no-finding', correct: false, falseAlarm: false, observedFinding: { reason: 'SECRET_TRACE'.repeat(10000) } }, { caseId: 'success', lane: 'development', repeat: 0, sourceDigest: digest('other'), outcome: 'no-finding', correct: true, falseAlarm: false }];
  const text = transform(feedback);
  assert(!text.includes('SECRET_TRACE')); assert(!text.includes('DEV-IDENTITY'));
  assert(text.includes('confirmed-detection-miss')); assert(text.includes('preserve-success'));
  assert(Buffer.byteLength(text) <= preregistration.summaryLimits.maxBytes);
  assert.equal(transform([...feedback, { ...feedback[0], caseId: 'SEALED-FINAL', lane: 'held-out' }]), text);
});
test('executes both equal-limit ablation arms and records negative/inconclusive control result', async () => {
  const options = inputs(); const prompts = [];
  const result = await runSummaryAblation({ ...options, mode: 'controls', providerFactory: arm => { const provider = deterministicControlProvider(); return async input => { if (input.role === 'proposal') prompts.push({ arm, prompt: input.prompt }); return provider(input); }; } });
  assert.equal(prompts.length, 2); assert.notEqual(prompts[0].prompt, prompts[1].prompt);
  assert.equal(result.arms['current-feedback'].cost.dispatchedCalls, options.protocol.maxCalls);
  assert.equal(result.arms['compact-summary'].cost.dispatchedCalls, options.protocol.maxCalls);
  assert.equal(result.primaryComparison.meanGain, 0); assert.deepEqual(result.primaryComparison.interval95, [-1, 1]);
  assert.equal(result.actualSharedMeteredTariffUsd, 0); assert.equal(result.invoiceUsd, 0);
  assert.equal(result.conclusion, 'inconclusive'); assert.equal(result.currentFeedbackRetained, true);
  for (const arm of Object.values(result.arms)) { assert.equal(arm.controls.aaDisagreements, 0); assert.equal(arm.controls.regressionDetected, true); }
});
test('shared unknown-billing stop prevents dispatch of the second arm', async () => {
  const options = inputs(); let factories = 0;
  const result = await runSummaryAblation({ ...options, mode: 'controls', providerFactory: () => { factories++; return deterministicControlProvider({ unknownUsageAt: 1 }); } });
  assert.equal(factories, 1); assert.equal(result.unknownUsage, true); assert.equal(result.arms['compact-summary'], null); assert.equal(result.invoiceUsd, null);
});
test('paid ablation requires shared cap and completed reconciled basic pilot', async () => {
  const options = inputs(); let calls = 0; const providerFactory = () => { calls++; return deterministicControlProvider(); };
  await assert.rejects(runSummaryAblation({ ...options, mode: 'provider', providerFactory }), /shared spend cap/);
  await assert.rejects(runSummaryAblation({ ...options, mode: 'provider', providerFactory, approvedSharedBudgetUsd: 40 }), /reconciled billing/);
  await assert.rejects(runSummaryAblation({ ...options, mode: 'provider', providerFactory, approvedSharedBudgetUsd: 40, qualifiedPilotReport: { mode: 'provider', protocolDigest: options.protocol.protocolDigest, conclusion: 'inconclusive', cost: { unknownUsage: false, billedUsd: 1 }, receipts: [{ lane: 'final' }], pairedAnalysis: { regressionDetected: true } } }), /qualified model-backed pilot/);
  assert.equal(calls, 0);
});
