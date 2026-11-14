import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const dashboard=fileURLToPath(new URL('../packages/web/',import.meta.url));
test('model picker supports keyboard return to search, a single flat grouped list and catalog refresh',async()=>{
  const directory=await mkdtemp(resolve(dashboard,'.model-picker-keyboard-test-'));
  let browser,server;
  try{
    const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ModelPicker}from'./src/components/model-picker';function App(){const[models,setModels]=useState([...Array.from({length:30},(_,i)=>({id:'gpt-'+i,provider:'openai'})),{id:'claude-sonnet',provider:'anthropic'}]);const[selected,setSelected]=useState({providerId:'openai',model:'gpt-0'});const[pending,setPending]=useState(false);window.setModelPending=setPending;window.refreshModels=setModels;window.picked??=[];return <ModelPicker pending={pending} models={models} providers={[{id:'anthropic',label:'Team Claude account'}]} selected={selected} onSelect={m=>{window.picked.push(m);setSelected({providerId:m.provider,model:m.id})}}/>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',write:false,loader:{'.css':'empty','.svg':'dataurl'},alias:{'@':resolve(dashboard,'src')},logLevel:'silent'});
    // Constrain the fixture like a small popup to exercise focus-driven scrolling.
    const css='[role=menu]{display:flex;flex-direction:column;width:min(400px,calc(100vw - 24px));max-height:260px;background:white;color:black}[role=menu]>div{display:flex;min-height:0;flex-direction:column;overflow:hidden}[role=menu]>div>div:nth-child(2){display:flex;flex:1;min-height:0}[aria-label="Available models"]{max-height:170px;overflow:auto;flex:1;min-width:0}[aria-label="Filter models by provider"]{display:flex;flex-direction:column;width:40px;flex-shrink:0;overflow:auto}[data-model-option]{min-height:44px}';
    server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':request.url==='/fixture.js'?'application/javascript':'text/html'});response.end(request.url==='/fixture.js'?bundle.outputFiles[0].contents:`<style>${css}</style><div id="root"></div><script type="module" src="/fixture.js"></script>`)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:360,height:640}});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
    const trigger=page.getByRole('button',{name:'Choose model',exact:true});await trigger.click();const search=page.getByRole('textbox',{name:'Search models',exact:true});await search.waitFor();assert.equal(await search.evaluate(e=>e===document.activeElement),true);
    await search.evaluate(e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',isComposing:true,bubbles:true})));assert.equal(await search.evaluate(e=>e===document.activeElement),true,'IME candidate navigation stays in the search field');
    await search.press('ArrowDown');const first=page.getByRole('menuitem',{name:'gpt-29 OpenAI API',exact:true});assert.equal(await first.evaluate(e=>e===document.activeElement),true);assert.equal(await first.getAttribute('aria-current'),null,'newest model leads; only the current choice is marked');assert.equal(await page.getByRole('menuitem',{name:'gpt-0 OpenAI API',exact:true}).getAttribute('aria-current'),'true');
    await first.press('ArrowUp');assert.equal(await search.evaluate(e=>e===document.activeElement),true,'first model can return to editable search');
    await search.press('ArrowUp');const last=page.getByRole('menuitem',{name:'claude-sonnet Team Claude account',exact:true});assert.equal(await last.evaluate(e=>e===document.activeElement),true);assert.ok(await page.getByRole('group',{name:'Available models',exact:true}).evaluate(e=>e.scrollTop)>0,'jumping to the last model scrolls the result pane');
    assert.equal(await page.getByRole('group',{name:'Filter models by provider'}).count(),0,'no provider icon rail');
    assert.equal(await page.getByRole('group',{name:'Team Claude account',exact:true}).count(),1,'provider headings group one flat list');
    await last.press('ArrowDown');assert.equal(await search.evaluate(e=>e===document.activeElement),true,'ArrowDown past the last model wraps to search');await search.press('ArrowUp');await last.waitFor();await last.press('ArrowUp');await search.fill('Team Claude');assert.equal(await page.getByRole('menuitem').count(),1,'provider display labels are searchable');await search.fill('');
    await page.evaluate(()=>window.refreshModels([{id:'gpt-new',provider:'openai'}]));await page.getByRole('menuitem',{name:'gpt-new OpenAI API',exact:true}).waitFor();
    await search.press('ArrowDown');await page.keyboard.press('Enter');await page.getByRole('menu').waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.picked.map(m=>m.id)),['gpt-new']);assert.equal(await trigger.evaluate(e=>e===document.activeElement),true,'selection returns focus to the trigger');
    await trigger.click();await search.press('ArrowDown');await page.keyboard.type('x');assert.equal(await search.inputValue(),'x','typing while a model row is focused continues in search');await search.fill('');await search.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
    await trigger.click();
    await page.evaluate(()=>window.setModelPending(true));
    assert.equal(await page.locator('[data-slot=skeleton]').count(),0,'background refresh keeps the cached catalog visible');
    await page.getByRole('menuitem',{name:'gpt-new OpenAI API',exact:true}).waitFor();
    await page.evaluate(()=>window.refreshModels([]));
    await page.getByRole('status',{name:'Loading models',exact:true}).waitFor();
    assert.equal(await page.getByRole('group',{name:'Available models',exact:true}).getAttribute('aria-busy'),'true');
    assert.ok(await page.locator('[data-slot=skeleton]').count()>0,'a cold load displays model-shaped placeholders');
    assert.equal(await page.getByRole('menuitem').count(),0);
    await page.evaluate(()=>{window.refreshModels([{id:'gpt-new',provider:'openai'}]);window.setModelPending(false)});
    await page.getByRole('menuitem',{name:'gpt-new OpenAI API',exact:true}).waitFor();
    assert.equal(await page.locator('[data-slot=skeleton]').count(),0);
    await search.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(directory,{recursive:true,force:true});}
});
