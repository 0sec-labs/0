import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dashboard=fileURLToPath(new URL('../packages/dashboard/',import.meta.url));
test('chat findings show explicitly linked workflow evidence and distinguish unavailable provenance',async()=>{
  const directory=await mkdtemp(resolve(dashboard,'.chat-findings-test-'));
  try {
    const output=resolve(directory,'fixture.mjs');
    await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MemoryRouter} from 'react-router-dom';import {ChatFindings} from './src/console/chat-findings';export const render=()=>renderToStaticMarkup(<MemoryRouter><ChatFindings sessionId="live-chat" savedId="original-chat" onAdd={()=>{}} busy={false}/></MemoryRouter>);`,resolveDir:dashboard,loader:'tsx'},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',alias:{'@':resolve(dashboard,'src')},logLevel:'silent',plugins:[{name:'query-fixtures',setup(build){
      build.onResolve({filter:/^@\/api$/},()=>({path:'api',namespace:'fixture'}));
      build.onResolve({filter:/^@tanstack\/react-query$/},()=>({path:'queries',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='api'?'export function useBackendApi(){return {client:{backendId:"remote"},getDashboard(){},getRuns(){}}}':'export function useQuery(options){globalThis.chatFindingQueryKeys.push(options.queryKey);return globalThis.chatFindingQueries[options.queryKey[0]]}',loader:'js'}));
    }}]});
    const {render}=await import(pathToFileURL(output).href);
    const direct={fingerprint:'direct',latest:{id:'direct',scanId:'original-chat',timestamp:1,title:'Direct evidence',severity:'medium',status:'confirmed'}};
    const child={fingerprint:'child',sourceScanIds:['child-scan','later-scan'],latest:{id:'child',scanId:'later-scan',timestamp:2,title:'Workflow evidence',severity:'high',status:'confirmed'}};
    const runs=[{id:'workflow',conversation:{sessionId:'original-chat'},native:{scanIds:['child-scan']}}];
    globalThis.chatFindingQueryKeys=[];
    globalThis.chatFindingQueries={'chat-findings':{data:{groups:[direct,child]},refetch(){}},runs:{data:runs,refetch(){}}};
    const complete=render();
    assert.match(complete,/Direct evidence/);
    assert.match(complete,/Workflow evidence/);
    assert.match(complete,/href="\/b\/remote\/findings\/child"/);
    assert.match(complete,/href="\/b\/remote\/runs\/later-scan"/);
    assert.deepEqual(globalThis.chatFindingQueryKeys,[['chat-findings','remote'],['runs','remote']]);
    globalThis.chatFindingQueries.runs={isPending:true,refetch(){}};
    const pending=render();
    assert.match(pending,/Loading linked runs/);
    assert.match(pending,/Direct evidence/);
    assert.doesNotMatch(pending,/No findings in this chat yet/);
    globalThis.chatFindingQueries.runs={error:new Error('offline'),refetch(){}};
    const failed=render();
    assert.match(failed,/Findings from automations may be missing/);
    assert.match(failed,/Retry linked runs/);
    assert.match(failed,/Direct evidence/);
    globalThis.chatFindingQueries['chat-findings']={data:{groups:[]},refetch(){}};
    assert.match(render(),/Linked run findings are unavailable/);
  } finally {
    delete globalThis.chatFindingQueries; delete globalThis.chatFindingQueryKeys;
    await rm(directory,{recursive:true,force:true});
  }
});
