import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { aggregateXbowReports } from './xbow-cohorts.mjs';
const result=(id,flagFound,extra={})=>({id,flagFound,...extra});
const report=(results,extra={})=>({model:'model-a',mode:'agentic',runtime:'api',whiteBox:false,retries:1,results,...extra});
const input=(report,runId=1)=>({report,source:{runId,artifact:'shard-0',reportFile:'xbow-latest.json'}});
test('models, modes, retries, repeats and distinct runs never share a score',()=>{
 const summary=aggregateXbowReports([
 input(report([result('A',true)])),input(report([result('B',true)],{whiteBox:true})),
 input(report([result('C',true)],{model:'model-b'})),input(report([result('D',true)],{retries:3})),
 input(report([result('E',true,{attempts:3})],{repeatProtocol:{N:3,costCeilingUsd:9}})),input(report([result('A',false)]),2),
 ]);
 assert.equal(summary.cohorts.length,6);assert.equal(summary.counts.aggregate,5);assert.equal(summary.counts.blackBox,4);assert.equal(summary.counts.whiteBox,1);
 assert.equal(summary.singleRunClaimVerified,false);assert.equal(summary.aggregation,'retained-artifact-union');assert.equal(summary.perModel,undefined);
 assert.equal(summary.cohorts.find(c=>c.retries===3).singleAttemptPolicy,false);
 assert.equal(summary.cohorts.find(c=>c.repeatN===3).singleAttemptPolicy,false);
 assert.equal(summary.cohorts.find(c=>c.source.runId===2).solved,0);
});
test('missing mode or policy is not black-box or single-attempt evidence',()=>{
 const old={model:'model-a',results:[result('A',true)]};const s=aggregateXbowReports([input(old)]);
 assert.equal(s.counts.blackBox,0);assert.equal(s.counts.unknownMode,1);assert.equal(s.cohorts[0].singleAttemptPolicy,null);
});
test('ensemble winner remains bound to configured model set and policy',()=>{
 const s=aggregateXbowReports([input(report([result('A',true,{model:'winner',estimatedCostUsd:2})],{model:'loser,winner',runtime:'api(best-of-2)'}))]);
 const c=s.cohorts[0];assert.equal(c.selectedModel,'winner');assert.equal(c.configuredModel,'loser,winner');assert.equal(c.singleAttemptPolicy,false);assert.equal(c.totalCostUsd,null);
});
test('same physical report dedupes, repeated challenges stay explicitly non-single-attempt',()=>{
 const one=input(report([result('A',false),result('A',true)]));const s=aggregateXbowReports([one,one]);
 assert.equal(s.cohorts.length,1);assert.equal(s.cohorts[0].resultRows,2);assert.deepEqual(s.cohorts[0].repeatedChallengeIds,['A']);assert.equal(s.cohorts[0].singleAttemptPolicy,false);
});
test('repeat cost counts actual attempts, zero is known, missing costs remain missing',()=>{
 const s=aggregateXbowReports([input(report([result('A',true,{attempts:2,meanCostUsd:0.5})],{repeatProtocol:{N:5,costCeilingUsd:1}})),input(report([result('B',false,{estimatedCostUsd:0}),result('C',true)]),2)]);
 const repeat=s.cohorts.find(c=>c.repeatN===5);assert.equal(repeat.totalCostUsd,1);assert.equal(repeat.observedAttempts,2);
 const missing=s.cohorts.find(c=>c.source.runId===2);assert.equal(missing.knownCostUsd,0);assert.equal(missing.costRows,1);assert.equal(missing.missingCostRows,1);assert.equal(missing.totalCostUsd,null);
});
test('perRun cost and implicit repeat counts do not become a single attempt',()=>{
 const s=aggregateXbowReports([input(report([result('A',true,{perRun:[{cost:1},{cost:2}]})]))]);assert.equal(s.cohorts[0].observedAttempts,2);assert.equal(s.cohorts[0].singleAttemptPolicy,false);assert.equal(s.cohorts[0].totalCostUsd,3);
});
test('malformed truthy flag is rejected rather than counted',()=>{
 assert.throws(()=>aggregateXbowReports([input(report([result('A','false')]))]));
});
test('public bundle retains source-specific provenance and labels union',()=>{
 const dir=mkdtempSync(join(tmpdir(),'xbow-cohort-fixture-'));
 try {
  const a=join(dir,'a.json'),b=join(dir,'b.json'),out=join(dir,'out');
  writeFileSync(a,JSON.stringify(report([result('A',true)],{timestamp:'first',model:'a',whiteBox:false})));
  writeFileSync(b,JSON.stringify(report([result('B',true)],{timestamp:'second',model:'b',whiteBox:true})));
  execFileSync(process.execPath,[new URL('./build-public-bundle.mjs',import.meta.url).pathname,'--results',`${a},${b}`,'--traces',join(dir,'missing'),'--out',out,'--substrate-sha','fixture'],{stdio:'pipe'});
  const ledger=JSON.parse(readFileSync(join(out,'ledger.json'),'utf8'));assert.equal(ledger.cohorts.length,2);assert.equal(ledger.perModel,undefined);
  const meta=JSON.parse(readFileSync(join(out,'receipts','B','meta.json'),'utf8'));assert.equal(meta.model,'b');assert.equal(meta.mode,'white-box');assert.equal(meta.runTimestamp,'second');
  const readme=readFileSync(join(out,'README.md'),'utf8');assert.match(readme,/not single-run or single-shot/);assert.doesNotMatch(readme,/Headline model/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
