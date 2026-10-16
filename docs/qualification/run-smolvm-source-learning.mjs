// Real production-adapter qualification. Requires a freshly rebuilt pnpm build:bundle.
// Usage: node docs/qualification/run-smolvm-source-learning.mjs NODE_FIXTURE.tar LINUX_NODE_MODULES REPORT.json
// Uses three fresh VMs, deterministic host SSE fixtures, no live account or networking.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const repository=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert(process.argv[2]&&process.argv[3]&&process.argv[4], 'Provide approved Node fixture archive, Linux dependency directory and private report path');
const image=resolve(process.argv[2]),dependencies=resolve(process.argv[3]),reportPath=resolve(process.argv[4]);
const core=await import(repository+'/packages/core/dist/index.js');
const {LearningStore,learningProjectId}=await import(repository+'/packages/db/dist/index.js');
const {createIsolatedConsoleSession}=await import(repository+'/packages/cli/dist/console-execution.js');
const {loadWorkbenchConfig,saveWorkbenchConfig}=await import(repository+'/packages/cli/dist/workbench.js');
const {saveSettings,DEFAULT_SETTINGS}=await import(repository+'/packages/cli/dist/tui/settings.js');
async function identity() {
 const files=[];
 async function walk(directory,prefix='') { for(const entry of await readdir(directory,{withFileTypes:true})) {
  const path=prefix+entry.name;
  if(entry.isDirectory()) await walk(join(directory,entry.name),path+'/');
  else {assert(entry.isFile(),'Distribution contains nonregular file');const bytes=await readFile(join(directory,entry.name));files.push({path,bytes:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')});}
 }}
 await walk(repository+'/dist');files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
 return {entryDigest:hash(await readFile(repository+'/dist/0.js')),treeDigest:hash(JSON.stringify(files)),fileCount:files.length,hostAdapterDigest:hash(await readFile(repository+'/packages/cli/dist/console-execution.js')),buildCommitVerified:false};
}
const buildAtStart=await identity();
const {resolveSmolvmImage}=await import(repository+'/packages/core/dist/runtime/smolvm.js');
const imageDigest=await resolveSmolvmImage(image);
const originalConfig=loadWorkbenchConfig(); assert(originalConfig,'Existing approved workbench is required');
const root=realpathSync(await mkdtemp(join(dirname(repository),'0-learning-vm-qualification-')));
const home=join(root,'operator'),workspace=join(root,'source'),dbPath=join(root,'learning.sqlite'),sourceRoot=join(workspace,'service');
await mkdir(home,{mode:0o700});await mkdir(workspace,{mode:0o700});await mkdir(sourceRoot,{mode:0o700});
await writeFile(join(sourceRoot,'routes.ts'),'export const routeMarker = "customer-route";\n');
await writeFile(join(sourceRoot,'policy.ts'),'export const policyMarker = "tenant-policy";\n');
const {emptyEnablement,enable,writeEnablement}=await import(repository+'/packages/core/dist/plugins/enablement.js');
const scopeApproval=enable(emptyEnablement(workspace),'scope',{version:'1.0.0',capabilities:[],now:Date.now()}); assert(scopeApproval.ok);assert(writeEnablement(workspace,scopeApproval.record,home));
assert(core.getScopeEnforcementState(workspace,home).enabled,'Isolated fixture scope approval failed');
saveSettings({...DEFAULT_SETTINGS,executionProfile:'smolvm',updatePolicy:'off',singleModel:true,autoRoute:false},home);
saveWorkbenchConfig({...originalConfig,image,imageDigest,workspaceRoot:workspace,cpus:2,memoryMb:2048,storageGb:4},home);
const memory=new core.HuntMemoryStore({home});const learning=new LearningStore(dbPath);
const markers=[`routing-observation-${randomUUID()}`,`policy-observation-${randomUUID()}`];
const summaries=[`routes.ts exports routeMarker. Inspect it when mapping customer routing. ${markers[0]}`,`policy.ts exports policyMarker. Inspect it when mapping tenant policy. ${markers[1]}`];
const model='gpt-6.1',sessions=[],bodies=[],tools=[],executions=[],deadlines=new WeakMap();
let phase='save',call=0;
const sse=output=>new Response(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:30,output_tokens:10}}})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
const functionCall=(name,args)=>[{type:'function_call',id:'fc_'+randomUUID(),call_id:randomUUID(),name,arguments:JSON.stringify(args)}];
const answer=()=>sse([{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture step complete.'}]}]);
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 assert.equal(String(url),'https://chatgpt.com/backend-api/codex/responses','Unexpected host network attempt');
 const body=JSON.parse(options.body);bodies.push({phase,body});call++;
 if(phase==='save') {
  if(call===1) return sse(functionCall('read_file',{path:'/workspace/service/routes.ts'}));
  if(call===2) return sse(functionCall('read_file',{path:'/workspace/service/policy.ts'}));
  if(call===3) return sse(functionCall('remember_codebase',{title:'Routing observation',summary:summaries[0],paths:['routes.ts']}));
  if(call===4) return sse(functionCall('remember_codebase',{title:'Policy observation',summary:summaries[1],paths:['policy.ts']}));
 } else if(call===1&&(phase==='recall'||phase==='changed')) return sse(functionCall('read_file',{path:'/workspace/service/routes.ts'}));
 return answer();
};
const runtime={resolvedProvider:()=> 'chatgpt-codex',resolvedModel:()=>model,modelSelection:()=>({singleModel:true,autoRoute:false}),workbenchCredentialResolver:()=>async()=>({accessToken:'qualification-fixture-only'})};
function create() {
 const session=createIsolatedConsoleSession({runtime,target:'source:'+sourceRoot,workspaceRoot:workspace,codebaseLearning:true,tools:[core.TOOL_DEFINITIONS.read_file,core.TOOL_DEFINITIONS.remember_codebase],learningStore:learning,huntMemoryStore:memory,autonomyMode:'yolo',maxToolIterations:8,maxTurnTokens:64000,refineObjective:false,allowModelSelfExtension:false},{homeDir:home,dbPath,workspaceRoot:workspace,assets:{cliDist:repository+'/dist',dependencies},onExecution:state=>executions.push({phase,status:state.status,runId:state.runId})});
 assert(session,'Production adapter did not create isolated session');sessions.push(session);deadlines.set(session,AbortSignal.timeout(240000));return session;
}
const report={schemaVersion:1,startedAt:new Date().toISOString(),headAtTest:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),buildIdentity:buildAtStart,imageDigest,provider:'deterministic host SSE fixture',liveAccountUsed:false,network:false,hostCredentialsForwarded:false,workspace:root,outcome:'pending',checks:{}};
async function turn(session,text) {
 const result=await session.send(text,{onToolResult:(tool,result)=>tools.push({phase,name:tool.name,success:result.success})},{signal:deadlines.get(session)});
 assert.equal(result.stopReason,'end_turn');return result;
}
try {
 const first=create();await turn(first,'Inspect these source files and retain specific routing and policy observations.');await first.cleanup();
 assert.equal(first.execution.status,'stopped');
 const retained=learning.listKnowledge({projectId:learningProjectId(sourceRoot)});
 const routing=retained.find(entry=>entry.summary===summaries[0]),policy=retained.find(entry=>entry.summary===summaries[1]);
 assert(routing&&policy,'Host knowledge did not retain both guest lessons');assert.equal(routing.status,'current');assert.equal(policy.status,'current');
 assert.equal(memory.recallCodebase(sourceRoot,8).filter(note=>summaries.includes(note.summary)).length,2);
 assert.equal(tools.filter(tool=>tool.phase==='save'&&tool.name==='remember_codebase'&&tool.success).length,2);report.checks.hostLessonsRetained=true;report.checks.explicitYoloChildScope=true;
 phase='recall';call=0;const second=create();await turn(second,'Read the routing fixture and identify useful source context.');
 assert(bodies.filter(item=>item.phase==='recall').some(item=>markers.every(marker=>JSON.stringify(item.body).includes(marker))),'Fresh VM did not receive both retained lessons');
 assert(markers.every(marker=>!JSON.stringify(second.messages).includes(marker)),'Retained lesson leaked into persisted chat history');report.checks.freshVmRecall=true;report.checks.historyDoesNotContainHints=true;
 learning.setKnowledgeStatus(routing.id,'disabled');phase='disabled';call=0;
 await turn(second,'Continue checking the routing fixture.');
 const disabledBodies=bodies.filter(item=>item.phase==='disabled');assert(disabledBodies.length>0);
 assert(disabledBodies.every(item=>!JSON.stringify(item.body).includes(markers[0])),'Disabled routing lesson was reused');
 assert(disabledBodies.some(item=>JSON.stringify(item.body).includes(markers[1])),'Unrelated current policy lesson was lost');report.checks.disabledLessonExcluded=true;await second.cleanup();assert.equal(second.execution.status,'stopped');
 await writeFile(join(sourceRoot,'policy.ts'),'export const policyMarker = "changed-policy";\n');
 phase='changed';call=0;const third=create();await turn(third,'Read the routing fixture after the policy source changed.');
 const changedBodies=bodies.filter(item=>item.phase==='changed');assert(changedBodies.length>0);
 assert(changedBodies.every(item=>markers.every(marker=>!JSON.stringify(item.body).includes(marker))),'Changed or disabled source lesson was reused');
 assert.equal(learning.getKnowledge(policy.id).status,'stale');report.checks.changedSourceExcluded=true;await third.cleanup();assert.equal(third.execution.status,'stopped');
 const runIds=[...new Set(executions.map(item=>item.runId).filter(Boolean))];assert.equal(runIds.length,3);report.checks.threeFreshVms=true;report.checks.nativeTeardownConfirmed=true;
 report.buildUnchanged=JSON.stringify(buildAtStart)===JSON.stringify(await identity());assert(report.buildUnchanged,'Distribution changed while qualification ran');
 report.selectedConfigUnchanged=JSON.stringify(originalConfig)===JSON.stringify(loadWorkbenchConfig());assert(report.selectedConfigUnchanged);
 report.outcome='passed';
} catch(error) {report.outcome='failed';report.error=error.message;}
finally {
 for(const session of sessions)try{await session.cleanup();}catch(error){report.cleanupError=error.message;report.outcome='failed';}
 globalThis.fetch=originalFetch;learning.close();report.finishedAt=new Date().toISOString();report.providerRequests=bodies.length;report.tools=tools;report.executionSnapshots=executions;report.resources={cpus:2,memoryMb:2048,storageGb:4,vmDeadlineMs:240000};
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({outcome:report.outcome,error:report.error,checks:report.checks,providerRequests:report.providerRequests,report:reportPath}));
 process.exitCode=report.outcome==='passed'?0:1;
}
