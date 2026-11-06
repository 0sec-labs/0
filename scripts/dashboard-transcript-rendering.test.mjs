import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const dashboard=fileURLToPath(new URL('../packages/dashboard/',import.meta.url));
test('draft changes skip historical transcript rendering while streamed content and recovery remain current',async()=>{
 const directory=await mkdtemp(resolve(dashboard,'.transcript-render-test-'));let server,browser;
 try{
 const output=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{TranscriptTurns,useTranscriptControls}from'./src/console/transcript-turns';
 window.renders=0;const workers=new Map(),resolve=()=>{},select=()=>{};
 const initial={session:{id:'chat',status:'ready'},workers:[]};
 const turn={id:'one',user:{text:'Question'},assistantText:'Original',toolCalls:[],decisions:[],notices:[],isWorking:false};
 function App(){const[draft,setDraft]=useState('');const[snapshot,setSnapshot]=useState(initial);const[turns,setTurns]=useState([turn]);const[workspace,setWorkspace]=useState({busy:false});
 window.stream=()=>{setSnapshot({...initial,session:{id:'chat',status:'working'}});setTurns([{...turn,assistantText:'Streamed',isWorking:true}]);};
 window.recover=()=>{setWorkspace({busy:true});setTurns([{...turn,decisions:[{id:'approval',resolved:true,title:'Decision',kind:'tool',approved:true}]}]);};
 const controls=useTranscriptControls({...workspace,connectionRecovery:{providerId:"fixture",healthy:false,checking:false},modelSourceRecovery:{healthy:false,checking:false}},()=>{window.resolvedDraft=draft;},select);
 return <><input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/><TranscriptTurns snapshot={snapshot} turns={turns} turnWorkers={workers} {...controls} canWrite={true}/></>}
 createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent',plugins:[{name:'presentation-fixtures',setup(api){api.onResolve({filter:/.*/},args=>{
 if(!args.importer.endsWith('transcript-turns.tsx')||args.path.startsWith('react'))return;
 return {path:args.path,namespace:'presentation'};
 });api.onLoad({filter:/.*/,namespace:'presentation'},()=>({loader:'tsx',resolveDir:dashboard,contents:`import React from 'react';export const Link=({children})=><a>{children}</a>;export const ShieldCheck=()=>null;export const Button=({children,...props})=><button {...props}>{children}</button>;export const recoveredProviderError=()=>false;export const consoleErrorMessage=s=>s;export const needsProviderSignIn=()=>false;export const needsModelSourceReconnect=()=>false;export const Markdown=({text})=>{window.renders++;return <p>{text}</p>};export const TurnTimeline=({turn})=>{window.renders++;return <p>{turn.assistantText}</p>};export const InlineImage=()=>null;export const ApprovalPanel=({busy,onResolve})=><button onClick={()=>onResolve({approve:true})}>{busy?'Busy approval':'Ready approval'}</button>;export const ActivityRow=({children})=><div>{children}</div>;export const ActivityIndicator=()=>null;export const AgentOnboarding=()=>null;export const BrandMark=()=>null;export const WorkerTree=()=>null;export const isCancellation=()=>false;export const turnLimitNotice=()=>null;`}));}}]});
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<div id="root"></div><script>${output.outputFiles[0].text}</script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByText('Original',{exact:true}).waitFor();const initial=await page.evaluate(()=>window.renders);await page.getByRole('textbox',{name:'Draft'}).pressSequentially('Typing a followup');assert.equal(await page.evaluate(()=>window.renders),initial,'typing must not rerender transcript children');await page.evaluate(()=>window.stream());await page.getByText('Streamed',{exact:true}).waitFor();assert.ok(await page.evaluate(()=>window.renders)>initial,'new streamed data renders');await page.evaluate(()=>window.recover());await page.getByText('Busy approval',{exact:true}).waitFor();await page.getByRole('textbox',{name:'Draft'}).fill('Fresh callback');await page.getByRole('button',{name:'Busy approval'}).click();assert.equal(await page.evaluate(()=>window.resolvedDraft),'Fresh callback','memoized transcript action uses the latest closure');
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

test('composer grows and shrinks for multiline text with native sizing and a persistent fallback observer',async()=>{
 let server,browser;
 try{
 const output=await build({stdin:{contents:`import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';import{useComposerAutosize}from'./src/console/use-composer-autosize';
 const fallback=location.search.includes('fallback');const supports=CSS.supports.bind(CSS);CSS.supports=(...args)=>fallback&&args[0]==='field-sizing'?false:supports(...args);
 const Observer=window.ResizeObserver;window.observers=0;window.ResizeObserver=class extends Observer{constructor(callback){super(callback);window.observers++;}};
 function App(){const[text,setText]=useState('');const ref=useRef(null);const style=useComposerAutosize(ref,text);return <textarea aria-label="Draft" ref={ref} value={text} onChange={e=>setText(e.target.value)} style={{...style,width:300,padding:4,lineHeight:'24px',boxSizing:'border-box',resize:'none'}}/>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:dashboard,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<div id="root"></div><script>${output.outputFiles[0].text}</script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});
 for(const fallback of [false,true]){
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/${fallback?'?fallback':''}`);const input=page.getByRole('textbox',{name:'Draft'});await input.waitFor();const baseline=await input.evaluate(node=>node.getBoundingClientRect().height);await input.fill('first\nsecond\nthird');await page.waitForFunction(()=>document.querySelector('textarea').getBoundingClientRect().height>60);await input.fill(Array.from({length:30},(_,i)=>'line '+i).join('\n'));await page.waitForFunction(()=>document.querySelector('textarea').getBoundingClientRect().height===240);assert.ok(await input.evaluate(node=>node.scrollHeight>node.clientHeight));await input.fill('');await page.waitForFunction(height=>document.querySelector('textarea').getBoundingClientRect().height===height,baseline);assert.equal(await page.evaluate(()=>window.observers),fallback?1:0,'typing must not recreate fallback observers');await page.close();
 }
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));}
});
