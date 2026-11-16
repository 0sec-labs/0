import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const dashboard=fileURLToPath(new URL('../packages/web/',import.meta.url));
test('the Memory page lists every note, filters by folder, shows the empty line and forgets a note',async()=>{
  const directory=await mkdtemp(resolve(dashboard,'.memory-page-test-'));
  let server,browser;
  try{
    const stub=resolve(directory,'api.ts');
    await writeFile(stub,`const client={backendId:'local'};let notes=[{id:'m_1',text:'Run tests with pnpm test',scope:'global',source:'you',created:'2026-01-01T00:00:00Z',kind:'command'},{id:'m_2',text:'Triage: React escapes output',scope:'folder',folder:'/work/app',source:'0',created:'2026-01-02T00:00:00Z',kind:'avoid'}];window.calls=[];export const localControlFetch=async()=>new Response('{}',{status:404});export const useBackendApi=()=>({client,webFetchJson:async(path,options)=>{if(options?.method==='DELETE'){window.calls.push(path);notes=notes.filter(n=>!path.endsWith(n.id));return {}}return {enabled:true,kinds:['fix-decision','convention','command','avoid'],folders:['/work/app'],notes}}});`);
    const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MemoryRouter} from 'react-router-dom';import {MemoryPage} from './src/pages/memory-page';createRoot(document.getElementById('root')).render(<MemoryRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryPage/></QueryClientProvider></MemoryRouter>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',write:false,loader:{'.css':'empty','.svg':'dataurl','.png':'dataurl'},alias:{'@/api':stub,'@':resolve(dashboard,'src')},logLevel:'silent'});
    server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':request.url==='/fixture.js'?'application/javascript':'text/html'});response.end(request.url==='/fixture.js'?bundle.outputFiles[0].contents:'<div id="root"></div><script type="module" src="/fixture.js"></script>')});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText('Run tests with pnpm test',{exact:true}).waitFor();
    await page.getByText('Triage: React escapes output',{exact:true}).waitFor();
    await page.getByLabel('Show').selectOption('/work/app');
    assert.equal(await page.getByText('Run tests with pnpm test',{exact:true}).count(),0);
    await page.getByLabel('Show').selectOption('all');
    await page.getByRole('button',{name:'Forget',exact:true}).first().click();
    await page.waitForTimeout(800);
    await page.getByRole('dialog').getByRole('button',{name:'Forget',exact:true}).evaluate(button=>button.click());
    await page.waitForFunction(()=>window.calls.length===1,null,{timeout:5000});
    assert.equal((await page.evaluate(()=>window.calls)).length,1);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(directory,{recursive:true,force:true});}
});
