import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));

test("shared controls preserve keyboard, focus, select and menu compatibility", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".shared-controls-test-"));
  let server, browser;
  try {
    const bundle = await build({ stdin: { contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {Button} from './src/components/ui/button';import {Select} from './src/components/ui/select';import {Tooltip} from './src/components/ui/tooltip';
      import {NewChatButton} from './src/components/new-chat-button';import {Switch} from './src/components/ui/switch';import {Slider} from './src/components/ui/slider';import {DropdownMenu} from './src/components/ui/dropdown-menu';
      import {Dialog,DialogTrigger,DialogContent,DialogTitle} from './src/components/ui/dialog';import {Tabs,TabsList,TabsTrigger,TabsContent} from './src/components/ui/tabs';
      function App(){const[value,setValue]=useState('a'),[enabled,setEnabled]=useState(false),[effort,setEffort]=useState(1),[chosen,setChosen]=useState('');return <>
       <h1>Shared controls</h1><form onSubmit={event=>{event.preventDefault();setChosen('unexpected-submit')}}><NewChatButton onClick={()=>setChosen('new-chat')}/></form><NewChatButton iconOnly asChild><a href="/draft" data-testid="new-chat-link"/></NewChatButton><Select aria-label="Flavor" value={value} onValueChange={setValue} options={[{value:'a',label:'Apple'},{value:'b',label:'Banana'},{value:'c',label:'Cherry',disabled:true},{value:'',label:'No flavor'}]}/><output id="flavor">{value||'empty'}</output>
       <Tooltip content="A helpful hint" delay={0}><Button>Help</Button></Tooltip>
       <Switch aria-label="Enable feature" checked={enabled} onCheckedChange={setEnabled}/><Slider label="Thinking effort" min={0} max={3} step={1} value={effort} onValueChange={setEffort}/><output id="effort">{effort}</output>
       <DropdownMenu><DropdownMenu.Trigger render={<Button/>}>Actions</DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.Group><DropdownMenu.Label>Choose action</DropdownMenu.Label><DropdownMenu.Item selected={chosen==='run'} onClick={()=>setChosen('run')}>Run action</DropdownMenu.Item></DropdownMenu.Group></DropdownMenu.Content></DropdownMenu><output id="chosen">{chosen}</output>
       <Dialog><DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger><DialogContent><DialogTitle>Dialog title</DialogTitle><Button>Inside dialog</Button></DialogContent></Dialog>
       <Tabs defaultValue="one"><TabsList><TabsTrigger value="one">First tab</TabsTrigger><TabsTrigger value="two">Second tab</TabsTrigger></TabsList><TabsContent value="one">First panel</TabsContent><TabsContent value="two">Second panel</TabsContent></Tabs>
      </>};createRoot(document.getElementById('root')).render(<App/>);
    `, resolveDir: dashboard, loader: "tsx" }, outfile: resolve(directory,"fixture.js"),bundle:true,write:false,platform:"browser",format:"esm",jsx:"automatic",loader:{".css":"empty"},logLevel:"silent" });
    server=createServer((request,response)=>{if(request.url==='/fixture.js'){response.writeHead(200,{'Content-Type':'application/javascript'});response.end(bundle.outputFiles[0].contents);}else{response.writeHead(200,{'Content-Type':'text/html'});response.end('<style>body{font:14px sans-serif;padding:24px}button{padding:8px;margin:4px}[role=combobox]{display:block}[role=listbox],[role=menu],[role=dialog]{background:white;border:1px solid #aaa;padding:12px}[role=option],[role=menuitem]{display:block;padding:8px}[data-disabled]{opacity:.5}[role=slider]{display:block;width:20px;height:20px;border:1px solid}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'New chat',exact:true}).click();assert.equal(await page.locator('#chosen').textContent(),'new-chat');assert.equal(await page.getByRole('link',{name:'New chat',exact:true}).getAttribute('href'),'/draft');assert.equal(await page.getByTestId('new-chat-link').locator('svg').getAttribute('aria-hidden'),'true');
    await page.getByRole('combobox',{name:'Flavor'}).click();await page.getByRole('option',{name:'Banana',exact:true}).click();assert.equal(await page.locator('#flavor').textContent(),'b');
    await page.getByRole('combobox',{name:'Flavor'}).click();assert.equal(await page.getByRole('option',{name:'Cherry',exact:true}).getAttribute('data-disabled'),'');await page.getByRole('option',{name:'No flavor',exact:true}).click();assert.equal(await page.locator('#flavor').textContent(),'empty');
    await page.getByRole('button',{name:'Help',exact:true}).hover();await page.getByRole('tooltip',{name:'A helpful hint'}).waitFor();await page.mouse.move(0,0);
    await page.getByRole('switch',{name:'Enable feature'}).focus();await page.keyboard.press('Space');assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'true');
    await page.getByRole('slider',{name:'Thinking effort'}).focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#effort').textContent==='2');
    await page.getByRole('button',{name:'Actions',exact:true}).click();await page.getByRole('menuitem',{name:'Run action'}).click();assert.equal(await page.locator('#chosen').textContent(),'run');
    await page.getByRole('button',{name:'Open dialog',exact:true}).click();await page.getByRole('dialog',{name:'Dialog title'}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.getByRole('button',{name:'Open dialog',exact:true}).evaluate(e=>e===document.activeElement),true);
    await page.getByRole('tab',{name:'First tab'}).focus();await page.keyboard.press('ArrowRight');await page.getByRole('tabpanel',{name:'Second tab'}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
