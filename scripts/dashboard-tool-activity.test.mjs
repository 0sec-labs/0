import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const dashboard = fileURLToPath(new URL('../packages/dashboard/', import.meta.url));
test('live tools share one compact working row, reveal semantic details on demand, and respect reduced motion', async () => {
  const directory = await mkdtemp(resolve(dashboard, '.activity-test-'));
  let browser, server;
  try {
    const bundle = await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ToolActivity}from'./src/console/tool-activity';function App(){const[calls,setCalls]=useState([{id:'one',name:'read_file',arguments:{path:'demo.ts'},result:'source',isRunning:false}]);const[working,setWorking]=useState(true);window.setActivity=setCalls;window.finish=()=>setWorking(false);return <ToolActivity calls={calls} working={working} startedAt="2026-10-29T00:00:00Z" endedAt="2026-10-29T00:00:03Z"/>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',write:false,loader:{'.css':'empty'},alias:{'@':resolve(dashboard,'src')},logLevel:'silent'});
    const css = (await Promise.all(['motion.css','loader.css','controls.css'].map(name=>readFile(resolve(dashboard, '../ui/src/styles',name),'utf8')))).join('\n');
    server = createServer((req,res)=>{res.writeHead(200,{'Content-Type':req.url==='/fixture.js'?'application/javascript':'text/html'});res.end(req.url==='/fixture.js'?bundle.outputFiles[0].contents:`<style>${css}</style><div id="root"></div><script type="module" src="/fixture.js"></script>`);});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    browser = await chromium.launch({headless:true});const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const activity=page.locator('.console-tool-activity');
    const summary=page.locator('.console-tool-activity > .ui-disclosure > button');
    const details=page.locator('.console-tool-activity > .ui-disclosure > .ui-disclosure-reveal');
    await summary.waitFor();assert.equal(await summary.getAttribute('aria-expanded'),'false');
    assert.match(await summary.innerText(),/Working/);
    assert.match(await summary.innerText(),/Read demo.ts/,'the latest completed operation remains visible while the model works');
    assert.equal(await page.getByRole('button',{name:/Read demo.ts/}).count(),1,'latest operation and working status share one accessible row');
    assert.equal(await page.locator('[aria-label="Live tools"]').count(),0);
    assert.equal(await details.getAttribute('aria-hidden'),'true');
    assert.equal(await details.getAttribute('inert'),'','collapsed output cannot receive keyboard focus');
    await page.evaluate(()=>window.setActivity([
      {id:'read',name:'read_file',arguments:{path:'demo.ts'},result:'source',isRunning:false},
      {id:'search',name:'search_files',arguments:{query:'auth'},result:'match',isRunning:false},
      {id:'command',name:'run_command',arguments:{command:'printf done'},result:'done',isRunning:false},
      {id:'live',name:'bash',arguments:{command:'node check.js'},isRunning:true},
    ]));
    await page.waitForFunction(()=>document.querySelector('.console-tool-activity > .ui-disclosure > button').textContent.includes('node check.js'));
    assert.match(await summary.innerText(),/4 tool calls/);
    assert.equal(await summary.locator('.console-working-label').count(),1,'one working label replaces the old stacked activity preview');
    assert.equal(await page.locator('.ui-activity-stack-item').count(),0);
    await summary.click();assert.equal(await summary.getAttribute('aria-expanded'),'true');
    assert.equal(await details.getAttribute('aria-hidden'),'false');
    assert.equal(await page.locator('.console-tool-row').count(),3,'latest command details plus three earlier calls cover all four operations once');
    assert.equal(await page.getByLabel('bash command',{exact:true}).innerText(),'$ node check.js');
    assert.match(await details.innerText(),/Read demo.ts/);
    assert.match(await details.innerText(),/auth/);
    await summary.click();assert.equal(await summary.getAttribute('aria-expanded'),'false');
    assert.equal(await details.getAttribute('aria-hidden'),'true','collapsing hides details without losing disclosure state');
    assert.equal(await details.getAttribute('inert'),'');
    assert.equal(await page.getByRole('button',{name:/Read demo.ts/}).count(),0,'earlier calls leave the accessibility tree when collapsed');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await summary.locator('.console-working-label').evaluate(e=>getComputedStyle(e).animationName),'none');
    assert.equal(await summary.locator('.ui-loader-cell').first().evaluate(e=>getComputedStyle(e).animationName),'none');
    await page.evaluate(()=>{window.setActivity([{id:'one',name:'read_file',arguments:{},isRunning:false,result:'done'}]);window.finish();});
    await page.waitForFunction(()=>document.querySelector('.console-tool-activity > .ui-disclosure > button').textContent.includes('1 tool call'));
    assert.equal(await summary.getAttribute('aria-expanded'),'false','completion never auto-expands');
    assert.equal(await activity.getAttribute('data-active'),null,'completed work stops displaying active state');
    assert.equal(await summary.locator('.console-working-label').count(),0);
  } finally {await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(directory,{recursive:true,force:true});}
});
