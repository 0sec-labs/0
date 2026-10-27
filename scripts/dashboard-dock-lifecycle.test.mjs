import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build} from "esbuild";
const root=fileURLToPath(new URL("../",import.meta.url));
test("dock teardown preserves cached layout and never converts disposal events into user closes",async()=>{
  const directory=await mkdtemp("/tmp/0-dock-lifecycle-");
  try{
    const output=resolve(directory,"fixture.mjs");
    await build({entryPoints:[resolve(root,"packages/dashboard/src/console/dock-lifecycle.ts")],outfile:output,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
    const {createDockLifecycle}=await import(pathToFileURL(output).href);
    const gate=createDockLifecycle();
    const closed=[];const persisted=[];let connected=true;
    const original={views:["chat","chat:local~one","chat:bench~one"]};
    let cached=structuredClone(original);
    const dock={views:[...original.views],remove(id){this.views=this.views.filter(value=>value!==id);onRemove(id);onLayout();},dispose(){for(const id of [...this.views])this.remove(id);}};
    const onRemove=id=>{if(gate.consumeClose(dock,id,connected))closed.push(id);};
    const onLayout=()=>{if(gate.accepts(dock,connected))cached={views:[...dock.views]};};
    gate.activate(dock);onLayout();
    // Parent layout cleanup blocks events before the child's passive dispose.
    gate.deactivate();persisted.push(structuredClone(cached));dock.dispose();
    assert.deepEqual(closed,[]);
    assert.deepEqual(cached,original);
    assert.deepEqual(persisted,[original],"flush uses captured valid data instead of serializing disposed dock");
    const replacement={};gate.activate(replacement);
    assert.equal(gate.accepts(dock,true),false,"stale HMR owner cannot write after replacement");
    assert.equal(gate.consumeClose(dock,"chat:local~one",true),false);
    const current={};gate.activate(current);
    gate.close(current,"chat:local~one",true,()=>{assert.equal(gate.hasCloseIntent(current),true);assert.equal(gate.consumeClose(current,"chat:local~one",true),true);});
    assert.equal(gate.hasCloseIntent(current),false);
    assert.equal(gate.consumeClose(current,"chat:local~one",true),false,"unmarked library removal is never a user close");
    connected=false;
    assert.equal(gate.accepts(current,connected),false);
    let invoked=false;gate.close(current,"chat:local~one",connected,()=>{invoked=true;});assert.equal(invoked,false);
    gate.deactivate();gate.activate(current);
    assert.equal(gate.accepts(current,true),true,"StrictMode can re-acquire an existing kept instance");
  }finally{await rm(directory,{recursive:true,force:true});}
});
