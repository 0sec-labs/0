import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { build } from "esbuild";
const root=fileURLToPath(new URL("../",import.meta.url));
test("workers remain attached to launch turns across later messages and status updates",async()=>{
  const directory=await mkdtemp("/tmp/0-worker-turns-");
  try {
    const output=resolve(directory,"fixture.mjs");
    await build({entryPoints:[resolve(root,"packages/dashboard/src/console/worker-turns.ts")],outfile:output,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
    const {workersForTurn}=await import(pathToFileURL(output).href);
    const turn=(id,start,sequence,toolCalls=[])=>({id,startedAt:new Date(start).toISOString(),user:{sequence},toolCalls});
    const worker=(id,status,ts,parentId="main")=>({id,status,parentId,name:id,task:"Task",transcript:ts?[{turn:1,ts}]:[]});
    const earlier=worker("old-worker","completed",2500);
    const current=worker("new-worker","running",5000);
    const published=worker("event-worker","completed");
    const inherited=worker("child-worker","queued",undefined,"old-worker");
    const unknown=worker("legacy-worker","completed");
    const turns=[turn("first",1000,1,[{name:"spawn_agents",result:{agents:[{agent_id:"old-worker"}]}}]),turn("second",4000,10,[{name:"wait_agent",result:{agent_id:"old-worker"}}])];
    const events=[{type:"worker",sequence:5,occurredAt:new Date(2000).toISOString(),worker:published},{type:"worker",sequence:13,occurredAt:new Date(6000).toISOString(),worker:published}];
    const groups=workersForTurn({workers:[earlier,current,published,inherited,unknown],events},turns);
    assert.deepEqual(groups.get("first").map(item=>item.id),["old-worker","event-worker","child-worker","legacy-worker"]);
    assert.deepEqual(groups.get("second").map(item=>item.id),["new-worker"]);
    const after=workersForTurn({workers:[{...earlier,status:"running"},current,published,inherited,unknown],events},[...turns,turn("third",7000,20)]);
    assert.equal(after.get("third").length,0,"new messages do not acquire old workers");
    assert.equal(after.get("first")[0].id,"old-worker","status changes cannot move a launch anchor");
    const authoritative=workersForTurn({workers:[{...current,transcript:[{turn:1,ts:1500}]}],events:[]},[turns[0],turn("second",4000,10,[{name:"spawn_agent",result:JSON.stringify({agent_id:"new-worker"})}])]);
    assert.equal(authoritative.get("second")[0].id,"new-worker","spawn receipts override unreliable worker timestamps");
    assert.equal(workersForTurn({workers:[current],events:[]},[]).size,0);
  } finally {await rm(directory,{recursive:true,force:true});}
});
