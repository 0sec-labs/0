import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleOracle, parseConsoleFindings, consoleGrade } from './learning-console-paired.mjs';

test('authenticated ownership probes confirm disclosure and reject both safe controls', async () => {
  const verdicts = await consoleOracle();
  assert.deepEqual(verdicts.map(v=>[v.id,v.confirmed]), [['A',true],['B',false],['C',true],['D',false]]);
  assert.ok(verdicts.every(v=>v.legitimate.status===200 && v.legitimate.containsMarker && v.anonymous.status===401));
  assert.ok(verdicts.filter(v=>!v.expected).every(v=>v.unauthorized.status===403 && !v.unauthorized.containsMarker));
});
test('review answers cannot supply a successful oracle verdict', () => {
  const candidates = parseConsoleFindings('{"findings":[{"id":"B","category":"access-control","verified":true}]}');
  assert.deepEqual(candidates,[{id:'B',category:'access-control'}]);
  assert.deepEqual(consoleGrade(candidates,[{id:'A',expected:true,confirmed:true},{id:'B',expected:false,confirmed:false}]), {confirmed:0,falsePositiveCandidates:1,missed:1,recall:0});
  assert.throws(()=>parseConsoleFindings('{"findings":[{"id":"A","category":"access-control"},{"id":"A","category":"access-control"}]}'));
  assert.throws(()=>parseConsoleFindings('{"findings":[{"id":"outside","category":"access-control"}]}'));
});

test('inherited object keys are not accepted as fixture candidates', () => {
  assert.throws(()=>parseConsoleFindings('{"findings":[{"id":"__proto__","category":"access-control"}]}'));
});
