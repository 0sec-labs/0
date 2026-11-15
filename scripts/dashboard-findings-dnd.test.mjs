import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {webCss} from './dashboard-web-css.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
// The real FindingsBoard and drop rules, driven with real pointer, touch and keyboard input (no synthetic drag events).
const harness=`import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{FindingsBoard}from'./src/components/findings/findings-board';import{resolveDrop,findingStatus}from'./src/components/findings/findings-model';
const mk=(id,status,severity='high',triage='new')=>({fingerprint:id,count:1,latest:{id,title:'Finding '+id,severity,status:'discovered',category:'xss',triageStatus:triage,timestamp:Date.now()},workflow:{status,persistedStatus:status,recommendedStatus:status,phase:status,assignee:null}});
window.log=[];
function App(){const[groups,setGroups]=useState([mk('a','backlog','critical'),mk('b','backlog'),mk('c','todo'),mk('d','human_review'),mk('e','done')]);
 const move=(fp,target)=>{const g=groups.find(x=>x.fingerprint===fp);const d=resolveDrop(findingStatus(g),target);window.log.push({fp,target,ok:d.ok,reason:d.ok?null:d.reason});if(!d.ok)return;
  setGroups(list=>list.map(x=>x.fingerprint!==fp?x:d.kind==='triage'?{...x,latest:{...x.latest,triageStatus:'accepted'}}:{...x,workflow:{...x.workflow,status:d.status}}));};
 return <div style={{height:600,display:'flex',flexDirection:'column'}}><FindingsBoard groups={groups} orderBy="severity" direction="desc" activeFingerprint={null} cursorFingerprint={null} selected={new Set()} pendingFingerprint={null} fixPrs={new Map()} onOpen={fp=>window.log.push({open:fp})} onToggleSelect={()=>{}} onMove={move}/></div>};
createRoot(document.getElementById('root')).render(<App/>);`;
test('findings board drops cards by pointer, touch and keyboard and refuses invalid moves visibly',async()=>{
 const web=resolve(root,'packages/web'),dir=await mkdtemp(resolve(web,'.findings-dnd-'));let server,browser;
 try{
  const result=await build({stdin:{resolveDir:web,loader:'tsx',contents:harness},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',loader:{'.css':'empty','.svg':'dataurl'},alias:{'@':resolve(web,'src')},logLevel:'silent'});
  const css=await webCss(root);
  server=createServer((request,response)=>{if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(result.outputFiles[0].contents);}else if(request.url==='/app.css'){response.setHeader('Content-Type','text/css');response.end(css);}else response.end('<html class="dark"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:1700,height:700},hasTouch:true});const page=await ctx.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForSelector('[data-fingerprint]');
  const col=status=>page.locator(`[data-column="${status}"]`);
  const where=id=>page.evaluate(i=>document.querySelector(`[data-fingerprint="${i}"]`)?.closest('[data-column]')?.dataset.column,id);
  const last=()=>page.evaluate(()=>window.log.at(-1));
  const center=async loc=>{const b=await loc.boundingBox();return{x:b.x+b.width/2,y:b.y+b.height/2,b};};
  const dragTo=async(id,target,{release=true,dy=60}={})=>{const from=await center(page.locator(`[data-fingerprint="${id}"]`));const t=await target.boundingBox();
   await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(from.x+12,from.y+4,{steps:3});await page.mouse.move(t.x+t.width/2,t.y+dy,{steps:12});
   if(release){await page.mouse.up();}return{from,t};};
  // 1. Overlay follows the pointer, the target column highlights, drop moves the card and counts update.
  const todoBody=col('todo').locator('> div').last();
  const{t}=await dragTo('a',todoBody,{release:false});
const overlay=await page.locator('[data-overlay]').boundingBox({timeout:3000});
  assert.ok(Math.abs(overlay.x+overlay.width/2-(t.x+t.width/2))<=overlay.width/2,'drag preview sits under the pointer');
  assert.equal(await col('todo').getAttribute('data-drop'),'accept');
  assert.ok(await page.locator('[data-overlay]').evaluate(el=>el.parentElement.closest('#root')===null),'preview is portaled out of the board');
  await page.mouse.up();await page.waitForFunction(()=>document.querySelector('[data-column="todo"] [data-fingerprint="a"]'));
  assert.deepEqual(await last(),{fp:'a',target:'todo',ok:true,reason:null});
  assert.match(await col('todo').getAttribute('aria-label'),/Todo, 2 findings/);assert.equal(await page.locator('[data-overlay]').count(),0);
  // 2. Drop onto a card of another column, and onto an empty column.
  await dragTo('b',page.locator('[data-fingerprint="c"]'),{dy:0});await page.waitForFunction(()=>document.querySelector('[data-column="todo"] [data-fingerprint="b"]'));
  assert.equal(await where('b'),'todo');
  await dragTo('c',col('in_progress').locator('> div').last());await page.waitForFunction(()=>document.querySelector('[data-column="in_progress"] [data-fingerprint="c"]'));
  // 3. Invalid drop: refusal is shown while hovering and reported on drop; the card stays put.
  await dragTo('b',col('human_review').locator('> div').last(),{release:false});
  assert.equal(await col('human_review').getAttribute('data-drop'),'refused');assert.match(await col('human_review').getByRole('status').innerText(),/set by 0/);
  await page.mouse.up();assert.equal(await where('b'),'todo');assert.deepEqual((await last()).ok,false);assert.match((await last()).reason,/set by 0/);
  // A card that needs review can only be closed.
  await dragTo('d',col('todo').locator('> div').last());assert.equal(await where('d'),'human_review');assert.match((await last()).reason,/Needs review/);
  // 5. Outside any column and Escape both leave the card alone.
  const before=await page.evaluate(()=>window.log.length);
  await dragTo('b',page.locator('body'),{release:false,dy:2});await page.mouse.up();
  const escFrom=await center(page.locator('[data-fingerprint="b"]'));await page.mouse.move(escFrom.x,escFrom.y);await page.mouse.down();await page.mouse.move(escFrom.x+30,escFrom.y+30,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await where('b'),'todo');assert.equal(await page.evaluate(()=>window.log.length),before,'no move requested '+JSON.stringify(await page.evaluate(()=>window.log.slice(-2))));assert.equal(await page.locator('[data-overlay]').count(),0);
  // 6. A plain click still opens the detail, a drag does not.
  await page.locator('[data-fingerprint="b"]').click();assert.deepEqual(await last(),{open:'b'});
  // 7. Keyboard: Space lifts, Right hops one column, Space drops; Escape cancels; Enter opens.
  await page.locator('[data-fingerprint="b"]').focus();await page.keyboard.press('Space');await page.waitForSelector('[data-overlay]');await page.waitForTimeout(50);await page.keyboard.press('ArrowRight');await page.waitForSelector('[data-column="in_progress"][data-drop]');await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('[data-column="in_progress"] [data-fingerprint="b"]'),null,{timeout:3000});
  await page.locator('[data-fingerprint="b"]').focus();await page.keyboard.press('Space');await page.waitForSelector('[data-overlay]');await page.waitForTimeout(50);await page.keyboard.press('ArrowRight');await page.waitForSelector('[data-column="agent_review"][data-drop]');await page.keyboard.press('Escape');assert.equal(await where('b'),'in_progress');
  await page.keyboard.press('Enter');assert.deepEqual(await last(),{open:'b'});
  // 8. Auto-scroll: holding the card at the right edge reveals the far columns; Accepted is a review decision that stays visible as Accepted.
  const group=page.locator('[role=group]');const from=await center(page.locator('[data-fingerprint="a"]'));
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(from.x+10,from.y,{steps:2});await page.mouse.move(1695,from.y,{steps:6});
  await page.waitForFunction(()=>document.querySelector('[role=group]').scrollLeft>200,null,{timeout:4000});
  const acc=await col('accepted').boundingBox();await page.mouse.move(acc.x+acc.width/2,from.y+40,{steps:5});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('[data-column="accepted"] [data-fingerprint="a"]'),null,{timeout:3000});
  assert.deepEqual(await last(),{fp:'a',target:'accepted',ok:true,reason:null});
  // 9. Touch: press and hold, then move, then lift.
  await group.evaluate(el=>{el.scrollLeft=0;});const cdp=await ctx.newCDPSession(page);
  const tf=await center(page.locator('[data-fingerprint="c"]'));const tt=await center(col('backlog').locator('> div').last());
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tf.x,y:tf.y}]});await page.waitForTimeout(260);
  for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tf.x+(tt.x-tf.x)*i/8,y:tf.y+(tt.y+30-tf.y)*i/8}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('[data-column="backlog"] [data-fingerprint="c"]'),null,{timeout:3000});
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(dir,{recursive:true,force:true});}
});
