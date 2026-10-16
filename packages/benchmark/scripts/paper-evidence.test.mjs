import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadManifest, compareCohorts, summarizeXbow, summarizeAB, auditRouter, summarizeCybergym, generate, repoRoot } from './paper-evidence.mjs';

test('immutable inputs reject tampering, traversal and duplicate IDs',()=>{
  const root=mkdtempSync(join(tmpdir(),'paper-evidence-'));
  try {
    const bytes='{"passed":false}'; writeFileSync(join(root,'input.json'),bytes);
    const input={id:'run',path:'input.json',sha256:createHash('sha256').update(bytes).digest('hex')};
    assert.equal(loadManifest(root,{version:1,inputs:[input]}).run.passed,false);
    assert.throws(()=>loadManifest(root,{version:1,inputs:[input,input]}),/duplicate/);
    assert.throws(()=>loadManifest(root,{version:1,inputs:[{...input,path:'../input.json'}]}),/Invalid/);
    writeFileSync(join(root,'input.json'),'{"passed":true}');
    assert.throws(()=>loadManifest(root,{version:1,inputs:[input]}),/hash mismatch/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('cohort comparisons reject different snapshots and protocols',()=>{
  const p={asOf:'2026-05-04',protocol:'black-box',ids:['a','b']};
  assert.equal(compareCohorts(p,{...p,asOf:'2026-05-06'}),'incompatible cohorts');
  assert.equal(compareCohorts(p,{...p,protocol:'any-mode'}),'incompatible cohorts');
  assert.equal(compareCohorts(p,{...p,ids:undefined}),'unknown denominator');
  assert.equal(compareCohorts(p,{...p,ids:['c']}),'invalid subset');
  assert.equal(compareCohorts(p,{...p,ids:['a']}),'compatible subset');
});
test('success unions do not become single-shot or black-box model rates',()=>{
  const receipt={runId:1,artifact:'proof'};
  const data={solved:{blackBox:['a','a'],whiteBox:['a','b']},counts:{blackBox:1,whiteBox:2,aggregate:2},sources:{blackBox:{a:[receipt,receipt,{runId:2,artifact:'proof'}]},whiteBox:{a:[receipt]}},perModel:{m:{solved:2}}};
  const s=summarizeXbow(data);
  assert.equal(s.union,2); assert.equal(s.duplicateAttempts,1);
  assert.ok(s.warnings.some(w=>w.includes('both modes')));
  assert.ok(s.warnings.some(w=>w.includes('denominator')));
});
test('unknown costs cannot create savings and failures remain in denominator',()=>{
  const s=summarizeAB({control:[{passed:true,flagFound:true}],treatment:[{passed:false,flagFound:false,estimatedCostUsd:1}]});
  assert.equal(s.change,null); assert.equal(s.arms.treatment.failed,1); assert.equal(s.arms.control.cost,null);
});
test('weak labels preserve imbalance, duplicates and mixed target groups',()=>{
  const rows=[{label:1,label_source:'package_verdict',source:'XBEN-001-24/a',text:'same'},{label:0,label_source:'flag_extraction',source:'XBEN-001-24/b',text:'same'}];
  const s=auditRouter(rows,{n_samples:2,n_tp:1,n_fp:1,cv_metrics:{mean_f1:.96}});
  assert.equal(s.duplicateTexts,1); assert.equal(s.mixedLabelGroups,1); assert.equal(s.pooledAlwaysPositiveF1,2/3);
  assert.ok(s.warnings.some(w=>w.includes('efficacy claims omitted')));
});
test('campaign audit retains failed and duplicate tasks and missing identities',()=>{
  const s=summarizeCybergym([{taskId:'a',passed:true},{taskId:'a',passed:false},{passed:false}]);
  assert.equal(s.failed,2); assert.equal(s.duplicateTasks,1);
  assert.ok(s.warnings.includes('Missing target identities.'));
});
test('retained-input generation is deterministic and qualifies headline claims',()=>{
  generate(); const paths=['evidence-tables.md','evidence-tables.tex','evidence-audit.json'];
  const before=paths.map(p=>readFileSync(join(repoRoot,'docs/paper/generated',p),'utf8'));
  generate(); assert.deepEqual(paths.map(p=>readFileSync(join(repoRoot,'docs/paper/generated',p),'utf8')),before);
  assert.match(before[0],/Suppressed/); assert.match(before[0],/pooled, not identical-fold CV/);
  assert.match(before[1],/Claim-to-artifact/);
});
