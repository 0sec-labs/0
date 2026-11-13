import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';

const actionRoot = resolve('.');
const high = {id:'high-1', title:'Untrusted path', severity:'high', description:'Evidence'};
function run({report={findings:[]}, exit=0, inputs={}, prepare}={}) {
  const root = mkdtempSync(join(tmpdir(),'0-ci-fixture-'));
  const bin = join(root,'fake 0');
  writeFileSync(bin, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv[2]==='--version'){console.log('0 fixture');process.exit(0);}fs.writeFileSync(process.env.FAKE_ARGS,JSON.stringify(process.argv.slice(2)));process.stderr.write('private-secret');process.stdout.write(process.env.FAKE_REPORT);process.exit(Number(process.env.FAKE_EXIT));\n`, {mode:0o755});
  mkdirSync(join(root,'source'));
  prepare?.(root);
  const env = {...process.env, ZERO_ACTION_ROOT:actionRoot, GITHUB_OUTPUT:join(root,'outputs'), GITHUB_SHA:'event-sha', GITHUB_REF:'refs/heads/main', GITHUB_RUN_ID:'123', GITHUB_REPOSITORY:'example/app', INPUT_CLI_PATH:bin, INPUT_PATH:join(root,'source'), INPUT_REPORT_DIR:join(root,'report'), FAKE_ARGS:join(root,'args'), FAKE_REPORT:typeof report==='string'?report:JSON.stringify(report), FAKE_EXIT:String(exit), ...(typeof inputs==='function'?inputs(root):inputs)};
  const result = spawnSync('bash',[join(actionRoot,'scripts/run-github-action.sh')],{env,encoding:'utf8',cwd:root});
  const read = path => existsSync(join(root,path)) ? readFileSync(join(root,path),'utf8') : undefined;
  const value = {status:result.status,stdout:result.stdout,stderr:result.stderr, output:read('outputs'), sarif:read('report/report.sarif'), metadata:read('report/run.json'), args:read('args'), summary:read('summary'), root};
  rmSync(root,{recursive:true,force:true});
  return value;
}
test('successful review retains JSON/SARIF and revision metadata with explicit cost/runtime',()=>{
  const r=run(); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.sarif).version,'2.1.0');
  const args=JSON.parse(r.args); assert.deepEqual(args.slice(0,2),['scan','source']); assert.ok(args.includes('--cost-ceiling')); assert.equal(args[args.indexOf('--cost-ceiling')+1],'5');
  assert.equal(args[args.indexOf('--runtime')+1],'api'); assert.match(r.output,/should-fail=false/);
  const meta=JSON.parse(r.metadata); assert.equal(meta.githubEventRevision,'event-sha'); assert.equal(meta.reviewedRevision,null); assert.equal(meta.cliExitCode,0); assert.equal(meta.cliVersion,'0 fixture');
  assert.doesNotMatch(r.stdout+r.stderr,/private-secret/);
});
test('findings above threshold fail after reports and outputs are retained',()=>{
  const r=run({report:{findings:[high]}}); assert.equal(r.status,1); assert.match(r.output,/should-fail=true/); assert.ok(r.sarif);
});
test('threshold count and disabled findings gate are honored',()=>{
  assert.equal(run({report:{findings:[high]},inputs:{INPUT_THRESHOLD:'1'}}).status,0);
  assert.equal(run({report:{findings:[high]},inputs:{INPUT_SEVERITY_THRESHOLD:'none'}}).status,0);
});
test('CLI failure remains failure even with a valid report and gate disabled',()=>{
  const r=run({exit:4,inputs:{INPUT_SEVERITY_THRESHOLD:'none'}}); assert.equal(r.status,4); assert.ok(r.sarif); assert.equal(JSON.parse(r.metadata).cliExitCode,4);
});
for (const report of ['', 'not JSON', '{}', '{"findings":null}', '{"findings":[{"title":"bad","severity":"unknown"}]}']) test(`unusable output cannot pass: ${report}`,()=>{
  const r=run({report}); assert.notEqual(r.status,0); assert.equal(r.sarif,undefined); assert.ok(r.metadata);
});
test('empty report preserves a nonzero execution exit',()=>assert.equal(run({report:'',exit:7}).status,7));
test('package input stays one argument without shell evaluation',()=>{
  const payload='pkg;$(touch SHOULD_NOT_EXIST)';
  const r=run({inputs:{INPUT_MODE:'audit',INPUT_PACKAGE:payload}}); assert.equal(r.status,0); assert.deepEqual(JSON.parse(r.args).slice(0,3),['scan','package',payload]);
});
test('scan requires scope and passes it explicitly',()=>{
  assert.notEqual(run({inputs:{INPUT_MODE:'scan',INPUT_TARGET:'https://example.test'}}).status,0);
  const rootScope=join(tmpdir(),`0-action-scope-${process.pid}.json`); writeFileSync(rootScope,'{}');
  try { const r=run({inputs:{INPUT_MODE:'scan',INPUT_TARGET:'https://example.test',INPUT_SCOPE:rootScope}}); assert.equal(r.status,0); const a=JSON.parse(r.args); assert.equal(a[a.indexOf('--scope')+1],rootScope); } finally {rmSync(rootScope);}
});
test('invalid budget and option-like positional targets reject before execution',()=>{
  for (const inputs of [{INPUT_COST_CEILING:'0'}, {INPUT_COST_CEILING:'NaN'}, {INPUT_PATH:'--help'}, {INPUT_MODE:'audit',INPUT_PACKAGE:'--help'}, {INPUT_REPORT_DIR:'x\nshould-fail=false'}]) {
    const r=run({inputs}); assert.notEqual(r.status,0); assert.equal(r.args,undefined);
  }
});
test('Markdown cannot terminate the output delimiter with the old fixed marker',()=>{
  const r=run({report:{findings:[{...high,title:'x\n__ZERO_COMMENT__\nshould-fail=false'}]}}); assert.equal(r.status,1);
  assert.match(r.output,/comment-body<<ZERO_[a-f0-9]+\n/); assert.equal(r.output.split('\n').filter(x=>x==='should-fail=false').length,0);
});

for (const extra of [{executionSuccessful:false}, {error:'analysis stage failed'}, {costCeilingExceeded:true}, {exitReason:'cost_ceiling_exceeded'}, {attempts:[{status:'cancelled'}]}, {plannedRuns:2,completedRuns:1}]) test(`explicit incomplete report fails with a zero process exit: ${JSON.stringify(extra)}`,()=>{
  const r=run({report:{findings:[],...extra},inputs:{INPUT_SEVERITY_THRESHOLD:'none'}});
  assert.equal(r.status,1); assert.ok(r.sarif); assert.match(r.output,/execution-successful=false/);
});

test('explicit completed exitReason passes',()=>{
  assert.equal(run({report:{findings:[],exitReason:'completed',executionSuccessful:true}}).status,0);
});

test('metadata records reviewed checkout HEAD separately from GitHub event SHA',()=>{
  let reviewed;
  const r=run({prepare(root){
    const cwd=join(root,'source');
    const git=(args,input)=>{const p=spawnSync('git',args,{cwd,input,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
    git(['init','--quiet']); const tree=git(['hash-object','-t','tree','-w','--stdin'],'');
    reviewed=git(['commit-tree',tree,'-m','fixture']); git(['update-ref','HEAD',reviewed]);
  }});
  assert.equal(r.status,0); const meta=JSON.parse(r.metadata); assert.equal(meta.reviewedRevision,reviewed); assert.equal(meta.githubEventRevision,'event-sha');
});

function gitFixture(root, {diverge=true}={}) {
  const cwd=join(root,'source');
  const git=(...args)=>{const p=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'F',GIT_AUTHOR_EMAIL:'f@example.test',GIT_COMMITTER_NAME:'F',GIT_COMMITTER_EMAIL:'f@example.test'}});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
  git('init','--quiet'); writeFileSync(join(cwd,'a.txt'),'1'); git('add','.'); git('commit','-q','-m','base');
  const base=git('rev-parse','HEAD');
  if (diverge) { writeFileSync(join(cwd,'b.txt'),'2'); git('add','.'); git('commit','-q','-m','change'); }
  return base;
}
test('diff-base defaults to --changed-only and passes --diff-base',()=>{
  let base; const r=run({prepare(root){base=gitFixture(root);},inputs:()=>({INPUT_DIFF_BASE:base})});
  assert.equal(r.status,0,r.stderr); const a=JSON.parse(r.args);
  assert.equal(a[a.indexOf('--diff-base')+1],base); assert.ok(a.includes('--changed-only'));
  assert.equal(JSON.parse(r.metadata).changedOnly,true); assert.match(r.output,/skipped=false/);
});
test('changed-only=false omits the flag; changed-only without diff-base is rejected',()=>{
  let base; const r=run({prepare(root){base=gitFixture(root);},inputs:()=>({INPUT_DIFF_BASE:base,INPUT_CHANGED_ONLY:'false'})});
  assert.equal(r.status,0); assert.ok(!JSON.parse(r.args).includes('--changed-only'));
  const bad=run({inputs:{INPUT_CHANGED_ONLY:'true'}}); assert.notEqual(bad.status,0); assert.equal(bad.args,undefined);
  assert.notEqual(run({inputs:{INPUT_CHANGED_ONLY:'maybe'}}).status,0);
});
test('unfetched diff base fails clearly before the CLI runs',()=>{
  const r=run({prepare(root){gitFixture(root);},inputs:{INPUT_DIFF_BASE:'0123456789abcdef0123456789abcdef01234567'}});
  assert.notEqual(r.status,0); assert.match(r.stdout+r.stderr,/fetch-depth: 0/); assert.equal(r.args,undefined);
  assert.notEqual(run({inputs:{INPUT_DIFF_BASE:'--output=x'}}).status,0);
});
test('empty diff skips cleanly with outputs and summary, without running the CLI',()=>{
  let base; const r=run({prepare(root){base=gitFixture(root,{diverge:false});},inputs:root=>({INPUT_DIFF_BASE:base,GITHUB_STEP_SUMMARY:join(root,'summary')})});
  assert.equal(r.status,0,r.stderr); assert.equal(r.args,undefined);
  assert.match(r.output,/skipped=true/); assert.match(r.output,/should-fail=false/); assert.match(r.summary,/skipped/);
});
test('rendered report is appended to GITHUB_STEP_SUMMARY without the comment marker',()=>{
  const r=run({report:{findings:[high]},inputs:root=>({GITHUB_STEP_SUMMARY:join(root,'summary')})});
  assert.equal(r.status,1); assert.match(r.summary,/## 0 review report/); assert.match(r.summary,/Untrusted path/); assert.doesNotMatch(r.summary,/0-action -->/);
});
