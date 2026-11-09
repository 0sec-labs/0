import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightFiniteFixtures } from './security-evolution-study/finite-preflight.mjs';

test('fresh-process exploits distinguish all synthetic vulnerable/fixed/clean fixtures', () => {
  const report = preflightFiniteFixtures();
  assert.equal(report.cases.length, 9);
  assert.equal(report.cases.filter(c => c.observation.polluted).length, 3);
  assert.ok(report.cases.every(c => c.observation.pristine && c.observation.benign));
  assert.equal(new Set(report.cases.map(c => c.sourceDigest)).size, 9);
  assert.equal(report.independentReview, 'pending');
  assert.equal(report.conclusion, 'inconclusive');
  assert.equal(report.modelCalls, 0);
  assert.equal(report.billedUsd, null);
  assert.equal(Object.prototype.finiteStudyPolluted, undefined);
});
