import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const dashboard=fileURLToPath(new URL('../packages/dashboard/',import.meta.url));
test('reopening a mounted model picker refreshes stale account rows without blanking the catalog',async()=>{
  const directory=await mkdtemp(resolve(dashboard,'.model-refresh-test-'));
  let browser,server;
  try{
    const bundle=await build({stdin:{contents:`
      import React from 'react';import{createRoot}from'react-dom/client';
      import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
      import{ModelPicker}from'./src/components/model-picker';import{useModelCatalog}from'./src/console/use-model-catalog';
      window.modelNow=Date.now();Date.now=()=>window.modelNow;window.modelReads=0;
      const model=id=>({id,provider:'chatgpt-codex',source:'account',price:'Included',contextWindowTokens:null});
      const response=id=>({models:[model(id)],roles:[],diagnostics:[],providerId:null});
      async function readCatalog(){window.modelReads++;if(window.modelReads===1)return response('old-account-model');return new Promise(resolve=>{window.finishCatalog=()=>resolve(response('new-account-model'));});}
      function App(){const catalog=useModelCatalog({backendId:'local',webFetchJson:readCatalog,connectionIdentity:'fixture-account'});return <ModelPicker models={catalog.data?.models??[]} pending={catalog.isLoading} onOpen={catalog.refreshIfStale} onSelect={()=>{}}/>;}
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);
    `,resolveDir:dashboard,loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',write:false,loader:{'.css':'empty','.svg':'dataurl'},alias:{'@':resolve(dashboard,'src')},logLevel:'silent'});
    server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':request.url==='/fixture.js'?'application/javascript':'text/html'});response.end(request.url==='/fixture.js'?bundle.outputFiles[0].contents:'<div id="root"></div><script type="module" src="/fixture.js"></script>');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.modelReads===1);
    const trigger=page.getByRole('button',{name:'Choose model',exact:true});
    await trigger.click();await page.getByRole('menuitem',{name:'old-account-model ChatGPT / Codex',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'Search models',exact:true}).press('Escape');
    await trigger.click();assert.equal(await page.evaluate(()=>window.modelReads),1,'fresh reopening does not rediscover every provider');
    await page.getByRole('textbox',{name:'Search models',exact:true}).press('Escape');
    await page.evaluate(()=>{window.modelNow+=61_000;});await trigger.click();
    await page.waitForFunction(()=>window.modelReads===2,{},{timeout:3000});
    await page.getByRole('menuitem',{name:'old-account-model ChatGPT / Codex',exact:true}).waitFor();
    assert.equal(await page.getByRole('status').count(),0,'background refresh retains usable rows without a first-load placeholder');
    await page.getByRole('textbox',{name:'Search models',exact:true}).press('Escape');await trigger.click();
    assert.equal(await page.evaluate(()=>window.modelReads),2,'reopening during discovery joins the in-flight request');
    await page.evaluate(()=>window.finishCatalog());
    await page.getByRole('menuitem',{name:'new-account-model ChatGPT / Codex',exact:true}).waitFor();
    assert.equal(await page.getByRole('menuitem',{name:'old-account-model ChatGPT / Codex',exact:true}).count(),0,'removed account models disappear when fresh discovery completes');
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(directory,{recursive:true,force:true});}
});
