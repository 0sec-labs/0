import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build} from "esbuild";
const root=fileURLToPath(new URL("../",import.meta.url));
test("persisted dock chats reconcile only to accessible live sessions without resuming or mutating",async()=>{
  const directory=await mkdtemp("/tmp/0-dock-chat-state-");
  try{
    const output=resolve(directory,"fixture.mjs");
    await build({stdin:{contents:`export {reconcileDockChatState,dockWorkspaceStorageKey} from "./dock-chat-state";export {restoreDockLayout} from "./dock-layout";export {parseDockChatDrag} from "./dock-chat-drag";`,resolveDir:resolve(root,"packages/dashboard/src/console"),loader:"ts"},outfile:output,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
    const {reconcileDockChatState:reconcile,dockWorkspaceStorageKey,restoreDockLayout,parseDockChatDrag}=await import(pathToFileURL(output).href);
    const rootKey=dockWorkspaceStorageKey({backendId:"local"});
    assert.notEqual(rootKey,dockWorkspaceStorageKey({backendId:"local",embeddedSessionId:"secondary"}),"embedded reconciliation must never remove its own view from the root roster");
    assert.notEqual(dockWorkspaceStorageKey({backendId:"local",embeddedSessionId:"secondary"}),dockWorkspaceStorageKey({backendId:"bench",embeddedSessionId:"secondary"}),"nested stores retain host identity");
    const session=(id,extra={})=>({id,title:`Title ${id}`,target:"",status:"ready",updatedAt:"2026-10-23T12:00:00Z",createdAt:"2026-10-23T11:00:00Z",...extra});
    const sessions=[session("primary"),session("live"),session("closed",{status:"closed"}),session("new",{savedId:"durable"}),session("old",{savedId:"durable",status:"closed"})];
    const chats=[{id:"primary",title:"Main"},{id:"live",title:"Stale"},{id:"deleted",title:"Gone"},{id:"closed",title:"Closed"},{id:"old",title:"Before restart",savedId:"durable"},{id:"new",title:"Duplicate"}];
    const original=structuredClone({chats,sessions});
    const result=reconcile({chats,activeChatId:"old",sessions,primarySessionId:"primary"});
    assert.deepEqual(result,{chats:[{id:"live",title:"Title live"},{id:"new",title:"Title new",savedId:"durable"}],activeChatId:"new",chatIdRemap:{primary:null,deleted:null,closed:null,old:"new"}});
    assert.deepEqual({chats,sessions},original,"reconciliation is pure");
    assert.deepEqual(reconcile({...result,sessions,primarySessionId:"primary"}),{...result,chatIdRemap:{}},"reconciliation is idempotent");
    assert.equal(reconcile({chats,activeChatId:"deleted",sessions,primarySessionId:"primary"}).activeChatId,null);
    assert.equal(reconcile({chats,activeChatId:"primary",sessions,primarySessionId:"primary"}).activeChatId,null);
    assert.deepEqual(reconcile({chats,activeChatId:"old",sessions:[]}),{chats:[],activeChatId:null,chatIdRemap:{primary:null,live:null,deleted:null,closed:null,old:null,new:null}});
    const roster=[session("replacement-a",{savedId:"saved",updatedAt:"2026-10-22T12:00:00Z"}),session("replacement-b",{savedId:"saved"})];
    assert.equal(reconcile({chats:[{id:"prior",title:"Old",savedId:"saved"}],activeChatId:"prior",sessions:roster}).activeChatId,"replacement-b","newest visible replacement wins");
    assert.equal(reconcile({chats:[{id:"replacement-a",title:"Old",savedId:"saved"}],activeChatId:"replacement-a",sessions:roster}).activeChatId,"replacement-a","an existing live ID is authoritative");
    assert.equal(reconcile({chats:[{id:"saved",title:"Saved"}],activeChatId:"saved",sessions:roster}).activeChatId,"replacement-b","durable IDs map to live sessions");
    assert.equal(reconcile({chats:[{id:"old",title:"Old"}],activeChatId:"old",sessions}).activeChatId,"new","closed roster metadata supplies legacy savedId");
    const fallback=reconcile({chats:[{id:"blank",title:"Remembered"}],activeChatId:"blank",sessions:[session("blank",{title:"",target:""})]});
    assert.equal(fallback.chats[0].title,"Remembered");
    for(const corrupted of [null,{},"old-format",42]) assert.deepEqual(reconcile({chats:corrupted,activeChatId:{id:"live"},sessions}),{chats:[],activeChatId:null,chatIdRemap:{}});
    const malformed=reconcile({chats:[null,42,"live",{},[],{id:42},{id:"../escape"},{id:"live",title:42,savedId:{}},{id:"new",title:"A\u0000title"}],activeChatId:42,sessions});
    assert.deepEqual(malformed.chats,[{id:"live",title:"Title live"},{id:"new",title:"Title new",savedId:"durable"}]);
    assert.equal(malformed.activeChatId,null);
    const hosts=reconcile({chats:[{id:"same",title:"Local",backendId:"local"},{id:"same",title:"Remote",backendId:"bench"}],activeChatId:"bench~same",sessions:[session("same")],defaultBackendId:"local",primarySessionId:"primary"});
    assert.deepEqual(hosts.chats.map(item=>[item.backendId,item.id]),[["local","same"],["bench","same"]],"equal UUIDs on different hosts are separate resources");
    assert.equal(hosts.activeChatId,"bench~same","unloaded foreign host is preserved");
    const missingRemote=reconcile({chats:hosts.chats,activeChatId:hosts.activeChatId,sessions:[session("same")],sessionsByBackend:{bench:[]},defaultBackendId:"local"});
    assert.deepEqual(missingRemote.chats.map(item=>item.backendId),["local"]);
    assert.equal(missingRemote.chatIdRemap["bench~same"],null,"only the foreign host's loaded roster can remove its reference");
    const primaryOnly=reconcile({chats:hosts.chats,activeChatId:"bench~same",sessions:[session("same")],defaultBackendId:"local",primarySessionId:"same"});
    assert.equal(primaryOnly.chats[0].backendId,"bench","primary exclusion never removes a colliding foreign ID");
    const resumed=reconcile({chats:[{id:"old",title:"Old local",backendId:"local"},{id:"old",title:"Old remote",backendId:"bench",savedId:"durable"}],activeChatId:"bench~old",sessions:[session("old")],defaultBackendId:"local",sessionsByBackend:{bench:[session("new",{savedId:"durable"})]}});
    assert.equal(resumed.activeChatId,"bench~new");
    assert.equal(resumed.chatIdRemap["bench~old"],"bench~new");
    assert.equal(resumed.chats[0].id,"old");
    const layout={grid:{root:{type:"branch",data:[{type:"leaf",size:700,data:{id:"main",views:["chat","chat:same"],activeView:"chat"}},{type:"leaf",size:360,data:{id:"remote",views:["chat:bench~same"],activeView:"chat:bench~same"}}]}},panels:{chat:{id:"chat"},"chat:same":{id:"chat:same"},"chat:bench~same":{id:"chat:bench~same"}},activeGroup:"remote"};
    const legacyAux=structuredClone(layout);
    for (const id of ["details", "agents", "browser"]) { legacyAux.panels[id]={id}; legacyAux.grid.root.data.push({type:"leaf",data:{id:`aux-${id}`,views:[id],activeView:id}}); }
    const migrated=restoreDockLayout(legacyAux,["same","bench~same"]);
    assert.deepEqual(Object.keys(migrated.panels).sort(),["browser","chat","chat:bench~same","chat:same"],"old per-chat details and agents panes are removed while browser previews and conversation splits survive");
    const restored=restoreDockLayout(layout,["local~same","bench~same"],{same:"local~same"});
    assert.deepEqual(Object.keys(restored.panels),["chat","chat:local~same","chat:bench~same"]);
    assert.equal(restored.grid.root.data[1].size,360,"composite ID migration preserves split geometry");
    assert.equal(restored.activeGroup,"remote");
    const drag=parseDockChatDrag(JSON.stringify({sessionId:"same",backendId:"bench",title:"Remote",saved:true}),"local");
    assert.equal(drag.key,"bench~same");assert.equal(drag.saved,true);
    assert.equal(parseDockChatDrag({sessionId:"same"},"local").key,"local~same");
    assert.equal(parseDockChatDrag({sessionId:"bench~same",backendId:"local"},"local"),undefined,"payload cannot smuggle a different host through an ID");
    assert.equal(parseDockChatDrag({sessionId:"../bad",backendId:"bench"},"local"),undefined);
    assert.equal(parseDockChatDrag("not json","local"),undefined);


  }finally{await rm(directory,{recursive:true,force:true});}
});
