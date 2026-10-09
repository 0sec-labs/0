// Real qualification against a built CLI. Never modifies selected image/configuration.
// Usage: node docs/qualification/run-smolvm-live-provider.mjs IMAGE.tar LINUX_NODE_MODULES REPORT.json
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repository=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv[2] || !process.argv[3] || !process.argv[4]) throw new Error('Provide approved Node fixture archive, Linux node_modules directory and private report path');
const qualificationImage=resolve(process.argv[2]); const dependencies=resolve(process.argv[3]); const reportPath=resolve(process.argv[4]);
const {resolveSmolvmImage}=await import(repository+'/packages/core/dist/runtime/smolvm.js');
const qualificationDigest=await resolveSmolvmImage(qualificationImage);

import { createHash } from 'node:crypto';
const {readdir: identityReadDirectory, readFile: identityReadFile}=await import('node:fs/promises');
async function buildIdentity() {
 const files=[];
 async function walk(directory,prefix='') {
  for (const entry of await identityReadDirectory(directory,{withFileTypes:true})) {
   const path=prefix+entry.name;
   if(entry.isDirectory()) await walk(directory+'/'+entry.name,path+'/');
   else if(entry.isFile()) { const bytes=await identityReadFile(directory+'/'+entry.name); files.push({path,bytes:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')}); }
   else throw new Error('Qualification distribution contains a non-regular file');
  }
 }
 await walk(repository+'/dist'); files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
 return {entryDigest:digest(await identityReadFile(repository+'/dist/0.js')),treeDigest:digest(JSON.stringify(files)),fileCount:files.length,hostControllerModuleDigest:digest(await identityReadFile(repository+'/packages/cli/dist/workbench-console-session.js')),buildCommitVerified:false};
}
const buildAtStart=await buildIdentity();

import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const source=repository;
const {createConsoleRuntime,createWorkbenchProviderBroker}=await import(source+'/packages/core/dist/index.js');
const {runWorkbenchCli}=await import(source+'/packages/cli/dist/workbench-console-session.js');
const {loadWorkbenchConfig}=await import(source+'/packages/cli/dist/workbench.js');
// Scratch lives beside the checkout, not os.tmpdir(): workbench refuses workspaces under /var (macOS tmpdir is /private/var/folders).
const scratchRoot=process.env.ZERO_QUALIFICATION_TMPDIR?resolve(process.env.ZERO_QUALIFICATION_TMPDIR):dirname(source);
const workspace=realpathSync(await mkdtemp(join(scratchRoot,'0-live-provider-check-')));
let artifacts,passed=false;
try{
 const nonce=randomUUID(); await writeFile(join(workspace,'qualification.txt'),nonce+'\n');
 artifacts=realpathSync(await mkdtemp(join(scratchRoot,'0-live-provider-artifacts-')));
 const {createWebConsoleRuntime}=await import(source+'/packages/cli/dist/web/operator-services.js');
 const {runtime}=await createWebConsoleRuntime({providerId:'chatgpt-codex',singleModel:true,autoRoute:false}); const model=runtime.resolvedModel();
 if(runtime.resolvedProvider()!=='chatgpt-codex')throw new Error('Selected provider is not chatgpt-codex');
 const catalog=await runtime.codexModelCatalog(AbortSignal.timeout(15000));
 if(!catalog.some(item=>item.id===model))throw new Error('Selected model is absent from live account catalog');
 const broker=createWorkbenchProviderBroker({provider:'chatgpt-codex',models:[model],resolveCredentials:runtime.workbenchCredentialResolver(),limits:{maxRequests:8,maxConcurrent:1,timeoutMs:90000,maxRequestBytes:1048576,maxResponseBytes:1048576,maxTotalResponseBytes:4194304}});
 let providerCalls=0;const statuses=[];let stdout='',stderr='';
 const provider={...broker.grant,async request(envelope,signal){providerCalls++;const response=await broker.request(envelope,signal);statuses.push(response.status);return response;},close:broker.close};
 const report={schemaVersion:1,timestamp:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),provider:'chatgpt-codex',model,liveAccountCatalogVerified:true,hostCredentialsForwarded:false,workspace,artifacts};
 try{
  const configured=loadWorkbenchConfig();if(!configured)throw new Error('Workbench is not configured');
  report.selectedImageDigest=configured.imageDigest;
  const fixture={...configured,image:qualificationImage,imageDigest:qualificationDigest,cpus:2,memoryMb:2048,storageGb:4}; report.imageDigest=fixture.imageDigest;
  report.result=await runWorkbenchCli({workbench:{...fixture,workspaceRoot:workspace},selection:{model,provider:'chatgpt-codex',singleModel:true},provider,network:false,lifetimeMs:240000,idleMs:180000,assets:{cliDist:source+'/dist',dependencies},artifactDirectory:artifacts,args:['console','--model',model,'--mode','yolo','--max-tool-calls','6','--print','This is a disposable runtime qualification workspace. Use read_file to read qualification.txt, then use apply_patch to create guest-result.txt containing exactly the value you read plus a newline. Do not access network or other files. Reply with LIVE_GUEST_PASS and the value only after both tools succeed.'],onStdout:data=>stdout+=data,onStderr:data=>stderr+=data});
  report.sourceUnchanged=(await readFile(join(workspace,'qualification.txt'),'utf8'))===nonce+'\n';
  try{await readFile(join(workspace,'guest-result.txt'));report.guestOutputAbsentOnHostSource=false;}catch(e){report.guestOutputAbsentOnHostSource=e.code==='ENOENT';}
  const resultPath=join(artifacts,'artifacts','workspace','guest-result.txt');
  try{report.exportedOutputMatches=(await readFile(resultPath,'utf8')).trim()===nonce;}catch{report.exportedOutputMatches=false;}
  report.outcome=report.result.exitCode===0&&!report.result.cleanupFailed&&providerCalls>=2&&statuses.every(status=>status===200)&&stdout.includes('LIVE_GUEST_PASS')&&stdout.includes(nonce)&&report.sourceUnchanged&&report.guestOutputAbsentOnHostSource&&report.exportedOutputMatches?'passed':'failed';
 }catch(e){report.outcome='failed';report.error=e.message;}finally{await broker.close();}
 report.providerCalls=providerCalls;report.httpStatuses=statuses;report.stdout=stdout;report.stderr=stderr;
 report.buildIdentity=buildAtStart; report.buildUnchanged=JSON.stringify(buildAtStart)===JSON.stringify(await buildIdentity()); if(!report.buildUnchanged) report.outcome='failed';
 await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({outcome:report.outcome,error:report.error,model:report.model,providerCalls:report.providerCalls,statuses:report.httpStatuses,result:report.result}));passed=report.outcome==='passed';
}finally{
 // The report already records exported output checks; keep artifacts only for failed runs or ZERO_QUALIFICATION_KEEP_ARTIFACTS=1.
 await rm(workspace,{recursive:true,force:true});
 if(artifacts&&passed&&process.env.ZERO_QUALIFICATION_KEEP_ARTIFACTS!=='1') await rm(artifacts,{recursive:true,force:true});
}
process.exit(passed?0:1);
