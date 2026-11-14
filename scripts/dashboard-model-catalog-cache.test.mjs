import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(new URL('../packages/web/package.json',import.meta.url));
const {QueryClient,QueryObserver}=require('@tanstack/react-query');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const model={id:'z-ai/glm-fixture',provider:'openrouter',source:'account',price:'$1',contextWindowTokens:128000};
const catalog={models:[model],providerId:'openrouter',roles:['research'],diagnostics:[]};
const scope={backendId:'local',workspaceId:'workspace-a',userId:'alice',connectionIdentity:'account-a',teamMode:true};
test('model metadata restores within its account scope and refreshes without blanking warm results',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'0-model-catalog-cache-'));
  const clients=[];
  try{
    const output=join(dir,'cache.mjs');
    await build({entryPoints:[fileURLToPath(new URL('../packages/web/src/lib/model-catalog-cache.ts',import.meta.url))],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
    const {readModelCatalog,writeModelCatalog,modelCatalogQueryOptions,modelCatalogKey,MODEL_CATALOG_CACHE_MS}=await import(pathToFileURL(output).href);
    const rows=new Map();const storage={getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};
    const now=Date.now();
    writeModelCatalog(scope,{...catalog,credential:'never-save',models:[{...model,apiKey:'never-save'}],diagnostics:[{providerId:'openrouter',message:'never-save'}]},storage,now);
    assert.doesNotMatch([...rows.values()].join(''),/never-save|apiKey|credential/,'only whitelisted model metadata is persisted');
    assert.deepEqual(readModelCatalog(scope,storage,now),catalog);
    for(const change of [{backendId:'remote'},{workspaceId:'workspace-b'},{userId:'bob'},{connectionIdentity:'account-b'},{providerId:'openrouter'},{teamMode:false}]){
      assert.notDeepEqual(modelCatalogKey(scope),modelCatalogKey({...scope,...change}));
      assert.equal(readModelCatalog({...scope,...change},storage,now),undefined,'catalogs never cross host, workspace, user, account, endpoint-filter, or authentication scopes');
    }
    assert.equal(readModelCatalog(scope,storage,now+MODEL_CATALOG_CACHE_MS),undefined,'expired metadata is discarded');
    assert.equal(rows.size,0);
    writeModelCatalog(scope,catalog,storage,now+1000);
    assert.equal(readModelCatalog(scope,storage,now),undefined,'future timestamps do not extend the retention window');
    storage.setItem('irrelevant','not a catalog');
    const badStorage={getItem:()=>'{broken',setItem:()=>{throw Error('quota');},removeItem:()=>{}};
    assert.equal(readModelCatalog(scope,badStorage),undefined);
    assert.doesNotThrow(()=>writeModelCatalog(scope,catalog,badStorage));
    rows.clear();
    const cancelled=new AbortController();
    const late=modelCatalogQueryOptions(scope,async()=>{cancelled.abort();return catalog;},storage);
    await assert.rejects(late.queryFn({signal:cancelled.signal}),{name:'AbortError'});
    assert.equal(readModelCatalog(scope,storage),undefined,'disposed scopes cannot populate persistent metadata with a late response');
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);
    let reads=0;let finish;
    const load=()=>{reads++;return new Promise(resolve=>{finish=resolve;});};
    const cold=new QueryObserver(client,modelCatalogQueryOptions(scope,load,storage));
    assert.equal(cold.getCurrentResult().isPending,true,'a genuinely cold catalog requests the first-load skeleton');
    const closeCold=cold.subscribe(()=>{});await tick();assert.equal(reads,1);
    finish(catalog);await tick();assert.deepEqual(cold.getCurrentResult().data.models,[model]);closeCold();
    const warm=new QueryObserver(client,modelCatalogQueryOptions(scope,load,storage));
    const closeWarm=warm.subscribe(()=>{});await tick();
    assert.equal(warm.getCurrentResult().isPending,false);assert.equal(reads,1,'reopening within staleTime reuses in-memory data without a blocking fetch');closeWarm();
    const refreshedClient=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(refreshedClient);
    let failRefresh;
    const restored=new QueryObserver(refreshedClient,modelCatalogQueryOptions(scope,()=>{reads++;return new Promise((_resolve,reject)=>{failRefresh=reject;});},storage));
    assert.equal(restored.getCurrentResult().isPending,false,'page refresh restores rows before discovery finishes');
    assert.deepEqual(restored.getCurrentResult().data.models,[model]);
    const closeRestored=restored.subscribe(()=>{});await tick();assert.equal(reads,2,'restored metadata always revalidates in the background');
    assert.equal(restored.getCurrentResult().isFetching,true);assert.deepEqual(restored.getCurrentResult().data.models,[model]);
    failRefresh(Error('temporary discovery failure'));await tick();
    assert.equal(restored.getCurrentResult().isPending,false);assert.deepEqual(restored.getCurrentResult().data.models,[model],'background failures keep prior rows available');closeRestored();
    const changed=new QueryObserver(refreshedClient,modelCatalogQueryOptions({...scope,userId:'bob'},load,storage));
    assert.equal(changed.getCurrentResult().data,undefined,'switching account never borrows the previous observer catalog');
    assert.equal(changed.getCurrentResult().isPending,true);
  }finally{for(const client of clients)client.clear();await rm(dir,{recursive:true,force:true});}
});

test('custom provider connection changes drop prior models even when replacement discovery fails', async () => {
  const dir=await mkdtemp(join(tmpdir(),'0-custom-provider-cache-'));
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try {
    const output=join(dir,'cache.mjs');
    await build({entryPoints:[fileURLToPath(new URL('../packages/web/src/lib/model-catalog-cache.ts',import.meta.url))],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
    const {modelCatalogQueryOptions}=await import(pathToFileURL(output).href);
    const original={...scope,providerId:'openai',connectionIdentity:'opaque-account-a-endpoint-a'};
    const inventory={...catalog,providerId:'openai',models:[{...model,id:'account-a-only',provider:'openai'}]};
    const observer=new QueryObserver(client,modelCatalogQueryOptions(original,async()=>inventory));
    const unsubscribe=observer.subscribe(()=>{});
    await tick();
    assert.equal(observer.getCurrentResult().data.models[0].id,'account-a-only');
    for (const connectionIdentity of ['opaque-account-b-endpoint-a','opaque-account-b-endpoint-b']) {
      let fail;
      observer.setOptions(modelCatalogQueryOptions({...original,connectionIdentity},()=>new Promise((_resolve,reject)=>{fail=reject;})));
      assert.equal(observer.getCurrentResult().data,undefined,'old connection rows are never selectable while a new connection loads');
      assert.equal(observer.getCurrentResult().isPending,true);
      await tick();fail(Error('discovery unavailable'));await tick();
      assert.equal(observer.getCurrentResult().data,undefined,'failed replacement discovery cannot resurrect another connection catalog');
      assert.equal(observer.getCurrentResult().error.message,'discovery unavailable');
    }
    unsubscribe();
  } finally {client.clear();await rm(dir,{recursive:true,force:true});}
});
