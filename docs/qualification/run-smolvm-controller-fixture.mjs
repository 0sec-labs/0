// Real qualification against a built CLI. Never modifies selected image/configuration.
// Usage: node docs/qualification/run-smolvm-controller-fixture.mjs IMAGE.tar LINUX_NODE_MODULES REPORT.json
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

import { mkdtemp,writeFile,readFile,readdir,rm } from 'node:fs/promises';
import { realpathSync,existsSync } from 'node:fs';
import { join } from 'node:path';
const root=repository;
const { createWorkbenchConsoleSession,runWorkbenchCli }=await import(root+'/packages/cli/dist/workbench-console-session.js');
// Scratch lives beside the checkout, not os.tmpdir(): workbench refuses workspaces under /var (macOS tmpdir is /private/var/folders).
const scratchRoot=process.env.ZERO_QUALIFICATION_TMPDIR?resolve(process.env.ZERO_QUALIFICATION_TMPDIR):dirname(root);
const workspace=realpathSync(await mkdtemp(join(scratchRoot,'0-controller-fixture-')));
let artifact;
try{
 await writeFile(join(workspace,'fixture.txt'),'host source fixture\n',{mode:0o600});
 const model='gpt-6.1'; const providerRequests=[]; const events=[]; const executions=[]; let calls=0; let cancel=false;
 const sse=(response)=>new Response(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:response,usage:{input_tokens:20,output_tokens:8}}})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 const provider={provider:'chatgpt-codex',models:[model],async request(envelope,signal){
  providerRequests.push({provider:envelope.provider,model:envelope.model,bodyBytes:Buffer.byteLength(envelope.body)});
  if(cancel) return new Response(new ReadableStream({start(controller){signal?.addEventListener('abort',()=>controller.error(new Error('qualification cancelled')),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
  calls++;
  if(calls===1)return sse([{type:'function_call',id:'fc_read',call_id:'read_1',name:'read_file',arguments:JSON.stringify({path:'/workspace/fixture.txt'})}]);
  if(calls===2)return sse([{type:'function_call',id:'fc_patch',call_id:'patch_1',name:'apply_patch',arguments:JSON.stringify({patch:'*** Begin Patch\n*** Add File: guest-result.txt\n+guest execution wrote this\n*** End Patch'})}]);
  return sse([{type:'message',role:'assistant',content:[{type:'output_text',text:'Guest harness read the fixture and saved the output.'}]}]);
 }};
 const workbench={schemaVersion:1,image:qualificationImage,imageDigest:qualificationDigest,stateRoot:(await import(root+'/packages/cli/dist/workbench.js')).loadWorkbenchConfig().stateRoot,workspaceRoot:workspace,providers:['chatgpt-codex'],github:false,cpus:2,memoryMb:2048,storageGb:4};
 artifact=realpathSync(await mkdtemp(join(scratchRoot,'0-controller-artifacts-')));
 const session=createWorkbenchConsoleSession({config:{target:'source:'+workspace,workspaceRoot:workspace,autonomyMode:'copilot',maxToolIterations:6,maxTurnTokens:32000,refineObjective:false,allowModelSelfExtension:false,requestLocalScope:async()=>({scopePath:workspace})},workbench,selection:{model,provider:'chatgpt-codex',singleModel:true},provider,network:false,lifetimeMs:90000,idleMs:90000,assets:{cliDist:root+'/dist',dependencies},artifactDirectory:artifact,onExecution:snapshot=>executions.push(snapshot)});
 const report={schemaVersion:1,workspace,artifact,downloadBytes:0,hostCredentialsForwarded:false,network:false,provider:'host SSE fixture (no live account)',outcome:'pending'};
 try{
  const outcome=await session.send('Read fixture.txt and create guest-result.txt in this disposable workspace.',{onToolStart:(...args)=>events.push({type:'tool-start',args}),onToolResult:(...args)=>events.push({type:'tool-result',args}),onAssistantDelta:(...args)=>events.push({type:'assistant',args})});
  report.turn=outcome; report.sourceUnmodified=!existsSync(join(workspace,'guest-result.txt')); report.checkpoint=session.exportCheckpoint();
  cancel=true; const abort=new AbortController(); const timer=setTimeout(()=>abort.abort(),700);
  try{report.cancelledTurn=await session.send('Wait for the next response.',{}, {signal:abort.signal});}finally{clearTimeout(timer);}
  await session.cleanup(); report.execution=session.execution;
  report.artifactFiles=await readdir(join(artifact,'artifacts/workspace')); report.guestOutput=await readFile(join(artifact,'artifacts/workspace/guest-result.txt'),'utf8');
  report.savedState=JSON.parse(await readFile(join(artifact,'artifacts/state/controller/session.json'),'utf8'));
  report.outcome=report.sourceUnmodified&&report.turn.stopReason==='end_turn'&&report.cancelledTurn.stopReason==='cancelled'&&report.guestOutput==='guest execution wrote this'&&['read_file','apply_patch'].every(name=>events.some(event=>event.type==='tool-result'&&event.args[0]?.name===name&&event.args[1]?.success===true))&&report.execution.status==='stopped'?'passed':'failed';
 }catch(error){report.error=error.message;report.outcome='failed';try{await session.cleanup();}catch(cleanup){report.cleanupError=cleanup.message;}}
 report.providerRequests=providerRequests;report.events=events;report.executionSnapshots=executions;
 report.buildIdentity=buildAtStart; report.buildUnchanged=JSON.stringify(buildAtStart)===JSON.stringify(await buildIdentity()); if(!report.buildUnchanged) report.outcome='failed';
 await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({outcome:report.outcome,error:report.error,sourceUnmodified:report.sourceUnmodified,providerRequests:providerRequests.length,execution:report.execution,artifact}));
 process.exitCode=report.outcome==='passed'?0:1;
}finally{
 // The report already captures guest output and saved state; keep artifacts only for failed runs or ZERO_QUALIFICATION_KEEP_ARTIFACTS=1.
 await rm(workspace,{recursive:true,force:true});
 if(artifact&&process.exitCode===0&&process.env.ZERO_QUALIFICATION_KEEP_ARTIFACTS!=='1') await rm(artifact,{recursive:true,force:true});
}
