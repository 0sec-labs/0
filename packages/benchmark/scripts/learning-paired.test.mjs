import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePredictions, grade, validateFixtures } from './learning-paired.mjs';

test('candidate output cannot provide its own labels or verification receipt', () => {
  const candidates = parsePredictions('{"findings":[{"id":"B","category":"sql-injection","verified":true,"expected":true}]}');
  assert.deepEqual(candidates, [{ id: 'B', category: 'sql-injection' }]);
  assert.deepEqual(grade(candidates, [{ id: 'A', expected: true, verified: true }, { id: 'B', expected: false, verified: false }]), {
    truePositiveCandidates: 0, falsePositiveCandidates: 1, confirmedFindings: 0,
    unconfirmedCandidates: 1, missedVulnerabilities: 1, recall: 0, candidatePrecision: 0,
  });
});

test('duplicate, foreign and mismatched candidates are rejected', () => {
  for (const findings of [
    [{ id: 'A', category: 'sql-injection' }, { id: 'A', category: 'sql-injection' }],
    [{ id: 'outside', category: 'sql-injection' }],
    [{ id: 'A', category: 'path-traversal' }],
  ]) assert.throws(() => parsePredictions(JSON.stringify({ findings })));
});

test('real host validators distinguish both local vulnerable fixtures from their controls', async () => {
  const verdicts = await validateFixtures();
  assert.deepEqual(verdicts.map(v => [v.id, v.verified]), [['A', true], ['B', false], ['C', true], ['D', false]]);
  assert.ok(verdicts.every(v => v.requests > 0));
  assert.ok(verdicts.find(v => v.id === 'A').evidence.includes('boolean_diff'));
  assert.ok(verdicts.find(v => v.id === 'C').evidence.includes('root:x:0:0:'));
});
