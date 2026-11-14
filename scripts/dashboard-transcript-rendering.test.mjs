import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const dashboard=fileURLToPath(new URL('../packages/web/',import.meta.url));
test('composer grows and shrinks for multiline text with native sizing and a persistent fallback observer',async()=>{
 let server,browser;
 try{
 const output=await build({stdin:{contents:`import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';import{useComposerAutosize}from'./src/console/use-composer-autosize';
 const fallback=location.search.includes('fallback');const supports=CSS.supports.bind(CSS);CSS.supports=(...args)=>fallback&&args[0]==='field-sizing'?false:supports(...args);
 const Observer=window.ResizeObserver;window.observers=0;window.ResizeObserver=class extends Observer{constructor(callback){super(callback);window.observers++;}};
 function App(){const[text,setText]=useState('');const ref=useRef(null);const style=useComposerAutosize(ref,text);return <textarea aria-label="Draft" ref={ref} value={text} onChange={e=>setText(e.target.value)} style={{...style,width:300,padding:4,lineHeight:'24px',boxSizing:'border-box',resize:'none'}}/>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<div id="root"></div><script>${output.outputFiles[0].text}</script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});
 for(const fallback of [false,true]){
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/${fallback?'?fallback':''}`);const input=page.getByRole('textbox',{name:'Draft'});await input.waitFor();const baseline=await input.evaluate(node=>node.getBoundingClientRect().height);await input.fill('first\nsecond\nthird');await page.waitForFunction(()=>document.querySelector('textarea').getBoundingClientRect().height>60);await input.fill(Array.from({length:30},(_,i)=>'line '+i).join('\n'));await page.waitForFunction(()=>document.querySelector('textarea').getBoundingClientRect().height===224);assert.ok(await input.evaluate(node=>node.scrollHeight>node.clientHeight));await input.fill('');await page.waitForFunction(height=>document.querySelector('textarea').getBoundingClientRect().height===height,baseline);assert.equal(await page.evaluate(()=>window.observers),fallback?1:0,'typing must not recreate fallback observers');await page.close();
 }
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));}
});
