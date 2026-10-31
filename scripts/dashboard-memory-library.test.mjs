import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const dashboard=fileURLToPath(new URL('../packages/dashboard/',import.meta.url));
test('memory library distinguishes supporting files from reply sources and can stop using a lesson',async()=>{
  const directory=await mkdtemp(resolve(dashboard,'.memory-library-test-'));
  let server,browser;
  try{
    const stub=resolve(directory,'api.ts');
    await writeFile(stub,`const client={backendId:'local'};let status='current';window.memoryChanges=[];export const useBackendApi=()=>({client,webFetchJson:async(path,options)=>{if(options?.method==='PATCH'){window.memoryChanges.push({path,body:JSON.parse(options.body)});status='disabled';return {}}return {events:[],improvements:[],knowledge:[{id:'note-a',title:'Tenant ownership',summary:'Check tenant ownership before returning a record.',projectId:'project-a',sourceLinks:[{path:'src/routes.ts',hash:'0123456789abcdef'}],evidenceEventIds:['event-a'],status,updatedAt:'2026-10-25T00:00:00Z'}]}}});`);
    const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MemoryRouter} from 'react-router-dom';import {LearningPanel} from './src/components/learning-panel';createRoot(document.getElementById('root')).render(<MemoryRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LearningPanel/></QueryClientProvider></MemoryRouter>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',write:false,loader:{'.css':'empty'},alias:{'@/api':stub,'@':resolve(dashboard,'src')},logLevel:'silent'});
    server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':request.url==='/fixture.js'?'application/javascript':'text/html'});response.end(request.url==='/fixture.js'?bundle.outputFiles[0].contents:'<div id="root"></div><script type="module" src="/fixture.js"></script>')});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText('This library shows saved lessons, not which sources a particular reply used.',{exact:false}).waitFor();
    await page.getByText('Supporting files (1)',{exact:false}).click();
    await page.getByText('src/routes.ts · 0123456789ab',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.memoryChanges),[],'inspecting sources does not change a lesson');
    await page.getByRole('button',{name:'Stop using',exact:true}).click();
    await page.getByRole('button',{name:'Not in use',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.memoryChanges),[{path:'/api/console/learning/knowledge/note-a',body:{status:'disabled'}}]);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(directory,{recursive:true,force:true});}
});
