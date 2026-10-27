import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
test('shared motion preserves links and responds to OS and app reduced motion',async()=>{
 const dashboard=resolve(root,'packages/dashboard'),dir=await mkdtemp(resolve(dashboard,'.shared-motion-'));
 let browser,server;
 try {
  const bundle=await build({stdin:{resolveDir:dashboard,loader:'tsx',contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{Button,Loader,SelectionHighlight}from'@0/ui';
  function App(){const[long,setLong]=useState(false),[selected,setSelected]=useState('one');return <main><Button animateWidth onClick={()=>setLong(v=>!v)} data-testid="copy">{long?'Copied prompt. Paste into your agent.':'Copy prompt'}</Button><Button asChild animateWidth><a href="#destination">Link action</a></Button><Loader/><Loader waiting/><div style={{position:'relative',width:220}}><SelectionHighlight activeKey={selected}/>{['one','two'].map(id=><button key={id} data-ui-selected={selected===id||undefined} onClick={()=>setSelected(id)} style={{display:'block',position:'relative',width:220,height:40}}>{id}</button>)}</div></main>};createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,write:false,platform:'browser',format:'esm',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
  const cssName=(await readdir(resolve(dashboard,'dist/assets'))).find(n=>n.endsWith('.css'));
  const css=await readFile(resolve(dashboard,'dist/assets',cssName),'utf8');
  server=createServer((request,response)=>{if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(bundle.outputFiles[0].contents);}else if(request.url==='/app.css'){response.setHeader('Content-Type','text/css');response.end(css);}else response.end('<html class="dark"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator('a[href="#destination"]').count(),1);assert.equal(await page.locator('button a,a button').count(),0);
  await page.getByTestId('copy').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid=copy]').getAnimations().length>0);
  await page.evaluate(()=>Promise.all(document.querySelector('[data-testid=copy]').getAnimations().map(a=>a.finished)));
  await page.evaluate(()=>document.documentElement.dataset.reducedMotion='true');
  await page.getByTestId('copy').click();
  assert.equal(await page.getByTestId('copy').evaluate(e=>e.getAnimations().length),0);
  await page.getByRole('button',{name:'two',exact:true}).click();
  assert.equal(await page.locator('[data-ui-selected="true"]').innerText(),'two');
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(dir,{recursive:true,force:true});}
});
