import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
test('sidebar chat edge drop splits the dock and releases every drag preview',async()=>{
 const dashboard=resolve(root,'packages/dashboard'),dir=await mkdtemp(resolve(dashboard,'.dock-drag-'));let server,browser;
 try{
  const stub=resolve(dir,'persistent.ts');await writeFile(stub,`import{useState}from'react';export const usePersistentState=(_key,value)=>useState(value);`);
  const result=await build({stdin:{resolveDir:dashboard,loader:'tsx',contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{DockWorkspace,CHAT_DRAG_MIME}from'./src/console/dock-workspace';function App(){const[chats,setChats]=useState([]),[active,setActive]=useState(null),[primary,setPrimary]=useState('one');return <><div id="source" draggable onDragStart={e=>e.dataTransfer.setData(CHAT_DRAG_MIME,JSON.stringify({sessionId:'two',backendId:'local',title:'Second chat'}))}>Second chat</div><div style={{height:600}}><DockWorkspace persistenceKey="test" primarySessionId={primary} primaryTitle={primary==='one'?'First chat':'Second chat'} primaryClosable onClosePrimary={ref=>setPrimary(ref?.id??'new')} onCloseChat={key=>{setChats(old=>old.filter(c=>'local~'+c.id!==key));setActive(null);}} chat={<p>{primary==='one'?'First transcript':'Second transcript'}</p>} panels={{agents:null,details:null,browser:null}} activePanel={null} onActivePanelChange={()=>{}} extraChats={chats} activeChatId={active} onActiveChatChange={setActive} onOpenChat={(id,title)=>{setChats(old=>old.some(c=>c.id===id)?old:[...old,{id,backendId:'local',title,content:<p>Second transcript</p>}]);setActive('local~'+id);}}/></div></>};createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',loader:{'.css':'empty'},alias:{'@/lib/use-persistent-state':stub,'@':resolve(dashboard,'src')},logLevel:'silent'});
  const cssFile=(await readdir(resolve(dashboard,'dist/assets'))).find(n=>n.endsWith('.css'));const css=await readFile(resolve(dashboard,'dist/assets',cssFile),'utf8');
  server=createServer((request,response)=>{if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(result.outputFiles[0].contents);}else if(request.url==='/app.css'){response.setHeader('Content-Type','text/css');response.end(css);}else response.end('<html class="dark"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1200,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForSelector('.dv-groupview');
  const dt=await page.evaluateHandle(()=>new DataTransfer());await page.locator('#source').dispatchEvent('dragstart',{dataTransfer:dt});
  const host=page.locator('.console-dock-workspace'),rect=await host.boundingBox();const point={clientX:rect.x+rect.width-30,clientY:rect.y+250,dataTransfer:dt};
  await host.dispatchEvent('dragover',point);await page.waitForFunction(()=>getComputedStyle(document.querySelector('.console-chat-drop-preview')).display==='grid');
  await host.dispatchEvent('drop',point);await page.waitForFunction(()=>document.querySelectorAll('.dv-groupview').length===2);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.console-chat-drop-preview')).display==='none');
  assert.equal(await page.locator('.dv-drop-target-selection').count(),0);assert.equal(await page.getByText('Second transcript',{exact:true}).count(),1);
  // A later canceled drag must also release its preview.
  await host.dispatchEvent('dragover',point);await host.dispatchEvent('dragend',{dataTransfer:dt});await page.waitForFunction(()=>getComputedStyle(document.querySelector('.console-chat-drop-preview')).display==='none');await page.getByRole('button',{name:'Close First chat',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.dv-groupview').length===1);
  assert.equal(await page.getByText('Second transcript',{exact:true}).count(),1);assert.equal(await page.getByText('First transcript',{exact:true}).count(),0);
  assert.equal(await page.locator('.dv-drop-target-selection').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(dir,{recursive:true,force:true});}
});
