import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { digest, admitCorpus, extractTarFiles, sourceTask } from './security-evolution-study/corpus.mjs';
import { BASELINE_SKILL, preregister, admitProtocol, analyzeStudy } from './security-evolution-study/protocol.mjs';
import { runPreregisteredStudy, deterministicControlProvider } from './security-evolution-study/run.mjs';
function fixture() {
  const cases = [];
  for (const lane of ['development', 'selection', 'final']) for (const label of ['vulnerable', 'fixed', 'clean']) {
    const source = `${lane}:${label}:__proto__`;
    cases.push({ id: digest(source), family: `${lane}-${label}`, lane, label, source, sourceDigest: digest(source), sinks: ['__proto__'], advisory: 'fixture-advisory', tarballIntegrity: 'sha512-fixture' });
  }
  const corpus = { schemaVersion: 1, advisories: [{ id: 'fixture-advisory' }], cases };
  return { ...corpus, digest: digest(corpus) };
}
function tar(path, source, type = '0') {
  const bytes = Buffer.from(source); const header = Buffer.alloc(512);
  header.write(path); header.write(bytes.length.toString(8).padStart(11, '0'), 124); header.write(type, 156);
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(512)]));
}
test('source corpus binds bytes, disjoint families and all control lanes', () => {
  const corpus = fixture(); assert.equal(admitCorpus(corpus), corpus);
  const changed = structuredClone(corpus); changed.cases[0].source += 'tamper';
  assert.throws(() => admitCorpus(changed), /digest/);
  const leaked = structuredClone(corpus); leaked.cases[4].family = leaked.cases[0].family;
  const { digest: _, ...content } = leaked; leaked.digest = digest(content);
  assert.throws(() => admitCorpus(leaked), /family leakage/);
  assert.deepEqual(Object.keys(sourceTask(corpus.cases[0])), ['source', 'sourceDigest']);
});
test('tar reader extracts exact regular entries without writing filesystem paths', () => {
  assert.deepEqual(extractTarFiles(tar('package/index.js', 'const value = 1;'), ['package/index.js']), [{ path: 'index.js', source: 'const value = 1;' }]);
  assert.throws(() => extractTarFiles(tar('package/index.js', 'target', '2'), ['package/index.js']), /regular/);
  assert.throws(() => extractTarFiles(tar('../../outside', 'bad'), ['package/index.js']), /missing/);
});
test('preregistration reserves complete final validation and rejects changed objectives', () => {
  const corpus = fixture(); const protocol = preregister(corpus);
  assert.equal(protocol.maxCalls, 80); assert.equal(protocol.finalReservedCalls, 37);
  assert.equal(admitProtocol(protocol, corpus), protocol);
  assert.throws(() => preregister(corpus, { budgetUsd: 1 }), /complete study/);
  assert.throws(() => preregister(corpus, { model: 'gpt-floating-alias' }), /dated/);
  assert.throws(() => admitProtocol({ ...protocol, repeats: 3 }, corpus), /changed/);
});
test('real oracle control experiment executes A/A and injected regression without model calls', async () => {
  const corpus = fixture(); const protocol = preregister(corpus);
  const result = await runPreregisteredStudy({ corpus, protocol, mode: 'controls', provider: deterministicControlProvider() });
  assert.equal(result.cost.dispatchedCalls, protocol.maxCalls);
  assert.equal(result.cost.meteredTariffUsd, 0); assert.equal(result.cost.billedUsd, 0);
  assert.equal(result.pairedAnalysis.aaDisagreements, 0); assert.equal(result.pairedAnalysis.regressionDetected, true);
  assert.equal(result.conclusion, 'inconclusive'); assert.equal(result.automaticPromotion, false);
  assert.equal(result.arms.sequential.p95Ms, null); assert.deepEqual(result.pairedAnalysis.interval95, [-1, 1]);
  assert.equal(result.receipts.some(r => 'source' in r || 'version' in r), false);
});
test('unknown usage preserves reservation and prevents all subsequent dispatch', async () => {
  const corpus = fixture(); const protocol = preregister(corpus);
  const result = await runPreregisteredStudy({ corpus, protocol, mode: 'controls', provider: deterministicControlProvider({ unknownUsageAt: 1 }) });
  assert.equal(result.cost.dispatchedCalls, 1); assert.equal(result.cost.unknownUsage, true); assert.equal(result.cost.billedUsd, null);
  assert.equal(result.cost.reservedMaximumUsd, protocol.perCallCeilingUsd);
  assert(result.reasons.some(r => /reconcile/.test(r)));
});
test('paid path cannot dispatch without explicit cap and private final never reaches proposal', async () => {
  const corpus = fixture(); const protocol = preregister(corpus); let calls = 0;
  await assert.rejects(runPreregisteredStudy({ corpus, protocol, mode: 'provider', provider: async () => { calls++; } }), /approved campaign cap/);
  assert.equal(calls, 0);
  const control = deterministicControlProvider();
  await runPreregisteredStudy({ corpus, protocol, mode: 'controls', provider: async input => {
    if (input.role === 'proposal') { assert(!input.prompt.includes('selection')); assert(!input.prompt.includes('final')); assert(!input.prompt.includes(corpus.cases[6].id)); }
    return control(input);
  } });
});
test('ledger fsyncs reservations and refuses blind restart', async () => {
  const corpus = fixture(); const protocol = preregister(corpus); const dir = mkdtempSync(join(tmpdir(), '0-study-ledger-')); const ledgerPath = join(dir, 'ledger.jsonl');
  try {
    await runPreregisteredStudy({ corpus, protocol, mode: 'controls', provider: deterministicControlProvider({ unknownUsageAt: 1 }), ledgerPath });
    const events = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.type), ['preregister', 'reserve', 'indeterminate', 'stop']);
    await assert.rejects(runPreregisteredStudy({ corpus, protocol, mode: 'controls', provider: deterministicControlProvider(), ledgerPath }), /reconcile prior/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
