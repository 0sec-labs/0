import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finiteCorpus, sealFiniteProtocol, runFiniteStudy, gradeFiniteFinding, FINITE_BASELINE } from './security-evolution-study/finite-adapter.mjs';
const identity = { provider: 'fixture', model: 'mock-only', endpointDigest: 'mock', runtimeDigest: 'mock', decoding: { temperature: 'unknown', seed: 'unknown' } };
function protocol() {
  const corpus = finiteCorpus();
  return sealFiniteProtocol(corpus, { review: { corpusDigest: corpus.digest, reviewer: 'mock-reviewer', author: 'mock-author', status: 'accepted-with-limits' }, identity, rates: { inputPerMillion: 1, outputPerMillion: 1, cachedInputPerMillion: 1 } });
}
test('semantic oracle requires executable JSON exploit, not sink label agreement', () => {
  const c = finiteCorpus().cases.find(c => c.lane === 'development' && c.label === 'vulnerable');
  const finding = { vulnerable: true, sink: 'target[key]', reason: 'Inherited prototype traversal', payload: JSON.parse('{"__proto__":{"finiteStudyPolluted":true}}') };
  assert.equal(gradeFiniteFinding(c, finding).reproduced, true);
  assert.equal(gradeFiniteFinding(c, { ...finding, payload: { harmless: true } }).correct, false);
  assert.equal(gradeFiniteFinding(c, { ...finding, payload: null }).outcome, 'inconclusive');
});
test('shared controller executes34 metered calls, strips labels and freezes before controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finite-study-')); const requests = [];
  try {
    const result = await runFiniteStudy({ protocol: protocol(), mode: 'controls', ledgerPath: join(dir, 'ledger'), provider: async input => {
      requests.push(input);
      if (input.role === 'proposal') {
        const feedback = JSON.parse(input.prompt).developmentFeedback;
        assert.equal(feedback.length, 1);
        return { completed: true, text: JSON.stringify({ skill: FINITE_BASELINE }), usage: { inputTokens: 1, outputTokens: 1 } };
      }
      assert.deepEqual(Object.keys(input).sort(), ['caseRecord', 'maxOutputTokens', 'role', 'signal', 'skill']);
      assert.deepEqual(Object.keys(input.caseRecord).sort(), ['id', 'source', 'sourceDigest']);
      return { completed: true, text: JSON.stringify({ vulnerable: false, sink: '', reason: 'Mock control', payload: null }), usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    assert.equal(requests.length, 34);
    assert.equal(result.costLedger.length, 34);
    assert.equal(result.conclusion, 'inconclusive');
    assert.equal(result.receipts.filter(r => r.arm === 'aa').length, 3);
    assert.equal(result.receipts.filter(r => r.arm === 'baseline-extra-attempts').length, 9);
    assert.equal(result.stopReason, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('paid run needs approval and an independently reviewed unchanged seal', async () => {
  const p = protocol();
  await assert.rejects(runFiniteStudy({ protocol: p, ledgerPath: '/unused', provider: () => assert.fail('no dispatch') }), /approved campaign cap/);
  await assert.rejects(runFiniteStudy({ protocol: { ...p, maxCalls: 400 }, ledgerPath: '/unused' }), /sealed protocol/);
  assert.throws(() => sealFiniteProtocol(finiteCorpus(), { review: {}, identity, rates: {} }), /independent corpus review/);
});

test('recurated final negatives block returned-object prototype mutation too', () => {
  for (const c of finiteCorpus().cases.filter(c => c.lane === 'final' && c.label !== 'vulnerable')) {
    const grade = gradeFiniteFinding(c, { vulnerable: true, sink: 'input.values', reason: 'Probe returned prototype', payload: JSON.parse('{"name":"normal","values":{"__proto__":{"finiteStudyPolluted":true}}}') });
    assert.equal(grade.reproduced, false);
  }
});
test('unknown usage stops after one reservation and refuses blind ledger replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finite-unknown-')); let calls = 0;
  const p = protocol(); const ledgerPath = join(dir, 'ledger');
  const provider = async () => { calls++; return { completed: true, usage: null, text: '{}' }; };
  try {
    const result = await runFiniteStudy({ protocol: p, mode: 'controls', ledgerPath, provider });
    assert.equal(calls, 1);
    assert.equal(result.costLedger[0].state, 'indeterminate');
    assert.match(result.stopReason, /usage unknown/);
    await assert.rejects(runFiniteStudy({ protocol: p, mode: 'controls', ledgerPath, provider }), /ledger already exists/);
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('final negative results preserve prototype identity and own adversarial data keys', () => {
  for (const label of ['fixed', 'clean']) {
    const path = fileURLToPath(new URL(`./security-evolution-study/finite-fixtures/final/${label}.cjs`, import.meta.url));
    const program = `const f = require(${JSON.stringify(path)}); const result = f(JSON.parse('{"name":"normal","values":{"__proto__":{"finiteStudyPolluted":true}}}')); console.log(JSON.stringify([Object.getPrototypeOf(result) === Object.prototype, result.finiteStudyPolluted === undefined, Object.hasOwn(result, '__proto__')]));`;
    const result = spawnSync(process.execPath, ['--eval', program], { encoding: 'utf8', timeout: 2000, maxBuffer: 8192, env: {} });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [true, true, true]);
  }
});
