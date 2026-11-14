import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

// Synthetic evidence only; never starts a model turn, executes a report command,
// submits a finding, or changes an existing workspace database.
const root = resolve('.');
const directory = await mkdtemp(join(tmpdir(), '0-ci-report-browser-'));
const dbPath = join(directory, 'workspace.db');
const reportPath = join(directory, 'report.json');
const metadataPath = join(directory, 'run.json');
const registry = join(directory, 'engines.json');
const cli = join(root, 'packages/cli/dist/index.js');
const { chromium } = createRequire(join(root, 'packages/engine/package.json'))('playwright');
const env = { PATH: process.env.PATH, CI:'1', NO_COLOR:'1', ZERO_OFFLINE:'true', ZERO_NO_TELEMETRY:'1', DO_NOT_TRACK:'1', ZERO_CODEX_AUTH_JSON_PATH:join(directory,'no-auth.json'), ZERO_TEAM_CONFIG:'' };
let child, browser;
let output = '', errors = '';
const wait = ms => new Promise(done => setTimeout(done, ms));
try {
  await mkdir(join(directory,'.0'));
  await writeFile(join(directory,'.0','tui-settings.json'), JSON.stringify({executionProfile:'host-local',analyticsLevel:'off',updatePolicy:'off'}));
  await writeFile(registry, JSON.stringify({schemaVersion:1,engines:[]}));
  const report = { target:'repo:/ci/fixture', scanDepth:'quick', startedAt:'2026-11-13T10:00:00Z', completedAt:'2026-11-13T10:01:00Z', durationMs:60000, executionSuccessful:true, exitReason:'completed', summary:{totalAttacks:0,totalFindings:1,critical:0,high:1,medium:0,low:0,info:0}, warnings:[], findings:[{id:'source-finding',templateId:'source',title:'Synthetic CI path finding',description:'Synthetic evidence for report import QA.',severity:'high',category:'path-traversal',status:'confirmed',timestamp:Date.parse('2026-11-13T10:00:30Z'), evidence:{request:'src/path.ts:4',response:'Synthetic result',analysis:'CI source claim'}}] };
  await writeFile(reportPath,JSON.stringify(report));
  await writeFile(metadataPath,JSON.stringify({schemaVersion:1,repository:'example/fixture',reviewedRevision:'a'.repeat(40),githubEventRevision:'b'.repeat(40),cliVersion:'0 fixture',cliExitCode:0,runId:'123'}));
  // Exercise the published command registration with actual file IO and SQLite.
  const imported = spawnSync(process.execPath,[cli,'reports','import',reportPath,'--metadata',metadataPath,'--db-path',dbPath],{cwd:directory,env,encoding:'utf8',timeout:30000});
  assert.equal(imported.status,0,imported.stderr);
  const result = JSON.parse(imported.stdout.trim());
  assert.equal(result.alreadyImported,false);
  const again=spawnSync(process.execPath,[cli,'reports','import',reportPath,'--metadata',metadataPath,'--db-path',dbPath],{cwd:directory,env,encoding:'utf8',timeout:30000});
  assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout.trim()).alreadyImported,true);
  child = spawn(process.execPath,[cli,'web','--port','0','--db-path',dbPath,'--engines-config',registry,'--asset-dir',join(root,'packages/web/dist'),'--ready-json','--no-open'],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>{output=(output+data).slice(-32000);});
  child.stderr.on('data',data=>{errors=(errors+data).slice(-32000);});
  let origin;
  for(let end=Date.now()+30000;Date.now()<end;){
    assert.equal(child.exitCode,null,errors);
    const ready=/ZERO_DASHBOARD_READY (\{[^\n]+\})/.exec(output);
    if(ready){origin=JSON.parse(ready[1]).url;break;}
    await wait(50);
  }
  assert.ok(origin,'Disposable dashboard did not become ready: '+errors);
  const html=await(await fetch(origin)).text();
  const token=/<meta name="0-control-token" content="([^"]+)"/.exec(html)?.[1];assert.ok(token);
  const request=async path=>{const response=await fetch(new URL(path,origin),{headers:{'X-0-Control-Token':token}});assert.equal(response.status,200);return response.json();};
  const list=await request('/api/scans');assert.equal(list.scans.length,1);assert.equal(list.scans[0].ciImport.reviewedRevision,'a'.repeat(40));
  const snapshot=await request(`/api/scans/${result.scanId}/export?format=json`);
  assert.equal(snapshot.findings[0].status,'discovered');assert.equal(snapshot.executionSuccessful,false);assert.match(snapshot.warnings.at(-1).message,/Imported CI evidence/);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.goto(new URL(`/runs/${result.scanId}`,origin).href);
  await page.getByText('Imported CI report',{exact:true}).waitFor();
  await page.getByText('Synthetic CI path finding',{exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/Source execution: successful/);
  assert.equal(await page.getByRole('button',{name:/Resume/}).count(),0);
  console.log('CI artifact import, idempotency, browser provenance, findings, and passive export passed.');
} finally {
  await browser?.close();
  if(child && child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(done=>child.once('exit',done)),wait(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await new Promise(done=>child.once('exit',done));}}
  await rm(directory,{recursive:true,force:true});
}
