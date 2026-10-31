import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const dashboard = fileURLToPath(new URL('../packages/dashboard/', import.meta.url));
test('live tools stay compact until expanded, update their stack, and respect reduced motion', async () => {
  const directory = await mkdtemp(resolve(dashboard, '.activity-test-'));
  let browser, server;
  try {
    const bundle = await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ToolActivity}from'./src/console/tool-activity';function App(){const[calls,setCalls]=useState([{id:'one',name:'read_file',arguments:{path:'demo.ts'},result:'source',isRunning:false}]);const[working,setWorking]=useState(true);window.setActivity=setCalls;window.finish=()=>setWorking(false);return <ToolActivity calls={calls} working={working} startedAt="2026-10-29T00:00:00Z" endedAt="2026-10-29T00:00:03Z"/>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',write:false,loader:{'.css':'empty'},alias:{'@':resolve(dashboard,'src')},logLevel:'silent'});
    const css = await readFile(resolve(dashboard, '../ui/src/styles/motion.css'),'utf8');
    server = createServer((req,res)=>{res.writeHead(200,{'Content-Type':req.url==='/fixture.js'?'application/javascript':'text/html'});res.end(req.url==='/fixture.js'?bundle.outputFiles[0].contents:`<style>${css}</style><div id="root"></div><script type="module" src="/fixture.js"></script>`);});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    browser = await chromium.launch({headless:true});const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const summary=page.locator('.console-tool-activity > div > .ui-disclosure > button');
    await summary.waitFor();assert.equal(await summary.getAttribute('aria-expanded'),'false');
    assert.equal(await page.getByRole('button',{name:/read file/}).count(),0,'completed live tool rows never leak below collapsed summary');
    assert.equal(await page.locator('[aria-label="Live tools"]').count(),0);
    await page.evaluate(()=>window.setActivity(['read_file','search_files','run_command','update_todos'].map((name,i)=>({id:String(i),name,arguments:{},isRunning:i===3,result:i===3?undefined:'done'}))));
    await page.locator('.ui-activity-stack-count').waitFor();assert.equal(await page.locator('.ui-activity-stack-item').count(),3,'stack remains bounded');
    await summary.click();await page.getByRole('button',{name:/read file/}).waitFor();assert.equal(await summary.getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('.console-tool-row').count(),4);
    await summary.click();assert.equal(await page.locator('.console-tool-row').count(),0,'collapsing removes detailed tool rows');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.ui-activity-stack-item').first().evaluate(e=>getComputedStyle(e).animationName),'none');
    await page.evaluate(()=>{window.setActivity([{id:'one',name:'read_file',arguments:{},isRunning:false,result:'done'}]);window.finish();});
    await page.getByText('Used 1 tool',{exact:true}).waitFor();assert.equal(await page.locator('.console-tool-row').count(),0,'completion never auto-expands');
  } finally {await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(directory,{recursive:true,force:true});}
});
