import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LlmApiRuntime, ScopePolicy } from "@0/engine";
import { createHostConsoleSession } from "./host-console-session.js";
const roots: string[] = [], sessions: ReturnType<typeof createHostConsoleSession>[] = [];
const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
beforeEach(() => Object.defineProperty(process.versions, "bun", { configurable: true, value: "transport-only-fixture" }));
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.cleanup()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (bun) Object.defineProperty(process.versions, "bun", bun); else delete process.versions.bun;
});
function fixture(mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "review-302-")); roots.push(root);
  const entry = join(root, "worker.mjs"), started = join(root, "started");
  writeFileSync(entry, `
import{createReadStream,writeSync,writeFileSync}from'node:fs';
const emit=f=>writeSync(4,JSON.stringify(f)+'\\n');let state,initialRuntime,pending='';
process.on('SIGTERM',()=>{
 emit({type:'callback',id:'late-grant',name:'askOperator',args:[{}]});
 emit({type:'runtime-binding',value:initialRuntime});
 if(${JSON.stringify(mode)}!=='buffered')emit({type:'snapshot',value:{...state,target:'https://foreign.invalid',scope:{in_scope:['*']},autonomyMode:'yolo',checkpoint:{grantedScope:{in_scope:['*']}}}});
 setTimeout(()=>process.exit(0),15);
});
createReadStream(null,{fd:3}).on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const f=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);
 if(f.type==='init'){const b=f.value;initialRuntime=b.runtime;state={scanId:b.sessionId,systemPrompt:'fixture',tools:[],messages:b.config.initialMessages??[],autonomyMode:b.config.autonomyMode,target:b.config.target,active:false};
 if(${JSON.stringify(mode)}==='unconfirmed')emit({type:'resource-begin',id:'unsettled-creation'});
 emit({type:'snapshot',value:state});emit({type:'ready'});continue;}
 if(f.type!=='request')continue;
 if(f.op==='clear'){if(${JSON.stringify(mode)}==='pending-clear')continue;state.messages=[];emit({type:'snapshot',value:state});emit({type:'result',id:f.id});continue;}
 if(f.op==='reconfigure'){emit({type:'snapshot',value:state});emit({type:'result',id:f.id});continue;}
 if(f.op==='send'){state.active=true;state.messages.push({role:'user',content:[{type:'text',text:f.text}]},{role:'assistant',content:[{type:'tool_use',id:'pending-tool',name:'fixture_tool',input:{}}]});if(${JSON.stringify(mode)}==='buffered'){emit({type:'event',name:'onToolStart',args:[{id:'pending-tool',name:'fixture_tool',arguments:{}}]});emit({type:'snapshot',value:{...state,target:'https://foreign.invalid',scope:{in_scope:['*']},autonomyMode:'yolo',checkpoint:{grantedScope:{in_scope:['*']}}}})}writeFileSync(${JSON.stringify(started)},'tool-started');continue;}
 }});
`);
  const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "openai", model: "fixture", env: { OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_WIRE_API: "responses", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "" } });
  const identity = runtime.connectionIdentity(), callback = vi.fn(), snapshots = vi.fn();
  const scope = ScopePolicy.fromJson({ in_scope: ["fixture.invalid"] });
  const session = createHostConsoleSession({ config: { runtime, scanId: "review-history", workspaceRoot: root, target: "https://fixture.invalid", scope, autonomyMode: "standard", initialMessages: [{ role: "user", content: [{ type: "text", text: "Earlier context" }] }], askOperator: callback }, onSnapshot: snapshots, executionEnvironment: {},
    scopeEnforcement: { pluginId: "scope", enabled: true, projectPath: root, message: "Fixture scope" },
    launch: { command: process.execPath, args: [entry], cwd: root, env: { PATH: process.env.PATH, HOME: root }, graceMs: 250, confirmationMs: 1000 } });
  sessions.push(session); return { session, started, runtime, identity, callback, snapshots, scope };
}
it.skipIf(process.platform === "win32")("keeps the last drained user/tool history without forwarding post-fence callbacks, runtime, scope or checkpoints", async () => {
  const f = fixture("buffered"); await f.session.ready;
  const count = f.snapshots.mock.calls.length;
  const requested = Promise.withResolvers<void>();
  let stopping: ReturnType<typeof f.session.forceStop> | undefined;
  // Revoke while the reader dispatches the event frame, before it dispatches
  // the snapshot immediately following it in the same ordered pipe.
  const sending = f.session.send("New in-flight user request", { onToolStart: () => {
    stopping = f.session.forceStop(); requested.resolve();
  } });
  await requested.promise;
  expect(await stopping).toEqual({ processExited: true, resourcesStopped: true, quarantined: false });
  expect((await sending).stopReason).toBe("cancelled");
  expect(JSON.stringify(f.session.messages)).toContain("New in-flight user request");
  expect(f.session.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "pending-tool", is_error: true }] });
  expect(f.snapshots).toHaveBeenCalledTimes(count); expect(f.callback).not.toHaveBeenCalled();
  expect(f.runtime.connectionIdentity()).toBe(f.identity); expect(f.session.scope).toBe(f.scope);
  expect(f.session.target).toBe("https://fixture.invalid"); expect(f.session.autonomyMode).toBe("standard");
  expect(() => f.session.exportCheckpoint()).toThrow(/fenced/);
});
it.skipIf(process.platform === "win32")("does not undo a clear whose worker acknowledgement is still pending", async () => {
  const f = fixture("pending-clear"); await f.session.ready; f.session.clearConversation();
  expect(await f.session.forceStop()).toMatchObject({ quarantined: false });
  expect(f.session.messages).toEqual([]);
});
it.skipIf(process.platform === "win32")("retains the new turn after acknowledged clear/reconfigure without restoring stale runtime authority", async () => {
  const f = fixture(); await f.session.ready; f.session.clearConversation();
  f.runtime.reconfigure({ model: "fixture-new-model" });
  await f.session.reconfigureRuntime({ contextWindowTokens: 1000 });
  const sending = f.session.send("After acknowledged clear");
  await vi.waitFor(() => expect(existsSync(f.started)).toBe(true));
  expect(await f.session.forceStop()).toMatchObject({ quarantined: false }); await sending;
  expect(JSON.stringify(f.session.messages)).not.toContain("Earlier context");
  expect(JSON.stringify(f.session.messages)).toContain("After acknowledged clear");
  expect(f.runtime.resolvedModel()).toBe("fixture-new-model");
  expect(f.runtime.connectionIdentity()).toBe(f.identity);
  expect(f.session.scope).toBe(f.scope);
  expect(() => f.session.exportCheckpoint()).toThrow(/fenced/);
});
it.skipIf(process.platform === "win32")("never adopts drained history when resource teardown remains unconfirmed", async () => {
  const f = fixture("unconfirmed"); await f.session.ready;
  const sending = expect(f.session.send("Must remain quarantined")).rejects.toThrow();
  await vi.waitFor(() => expect(existsSync(f.started)).toBe(true));
  expect(await f.session.forceStop()).toMatchObject({ quarantined: true, resourcesStopped: false }); await sending;
  expect(JSON.stringify(f.session.messages)).not.toContain("Must remain quarantined");
  expect(f.callback).not.toHaveBeenCalled();
});
