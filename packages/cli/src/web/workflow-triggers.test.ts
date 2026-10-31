import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect,vi} from "vitest";
import {SecurityWorkflowStore,WorkflowTriggerStore} from "@0/db";
import {WorkflowTriggerService} from "./workflow-triggers.js";
const now=Date.parse("2026-09-30T12:00:00.000Z");
const draft={name:"Dependency review",instructions:"",target:"source:/workspace",nodes:[{id:"start",type:"trigger",label:"Start",enabled:true},{id:"audit",type:"audit",label:"Audit",enabled:true}],edges:[{source:"start",target:"audit"}]};
async function fixture(run:(f:{service:WorkflowTriggerService;workflows:SecurityWorkflowStore;triggers:WorkflowTriggerStore;workflowId:string;launch:ReturnType<typeof vi.fn>;validate:ReturnType<typeof vi.fn>})=>Promise<void>) {
 const dir=mkdtempSync(join(tmpdir(),"zero-schedule-"));const path=join(dir,"control.db");const workflows=new SecurityWorkflowStore(path);const triggers=new WorkflowTriggerStore(path);const definition=workflows.save(draft);const launch=vi.fn(async()=>({executionId:workflows.createExecution(definition.id,"owner",1).id}));const validate=vi.fn(async()=>({model:"model",providerId:"provider"}));const service=new WorkflowTriggerService({dbPath:path,adapter:{launch,validate},pollIntervalMs:999999});
 try{await run({service,workflows,triggers,workflowId:definition.id,launch,validate});}finally{await service.dispose();workflows.close();triggers.close();rmSync(dir,{recursive:true,force:true});}
}
const fields=(workflowId:string)=>({workflowId,workflowRevision:1,sessionId:"owner",cadence:"hourly" as const,startAt:new Date(now).toISOString(),timezone:"UTC",enabled:true});
describe("scheduled workflow execution",()=>{
 it("runs a due occurrence once, waits for terminal state, then releases it",async()=>fixture(async f=>{
  const trigger=f.triggers.create(fields(f.workflowId),now-1000);await f.service.tick(now);expect(f.launch).toHaveBeenCalledTimes(1);await f.service.tick(now+3600000);expect(f.launch).toHaveBeenCalledTimes(1);const active=f.triggers.get(trigger.id)!;expect(active.lastStatus).toBe("running");f.workflows.updateExecution(active.lastExecutionId!,{status:"completed"});await f.service.tick(now+3600000);expect(f.triggers.get(trigger.id)?.activeClaim).toBeUndefined();
 }));
 it("pauses edited revisions and blocked permissions without launching",async()=>fixture(async f=>{
  const trigger=f.triggers.create(fields(f.workflowId),now-1000);const original=f.workflows.get(f.workflowId)!;const {createdAt:_c,updatedAt:_u,...input}=original;f.workflows.save({...input,name:"Changed"});await f.service.tick(now);expect(f.triggers.get(trigger.id)?.lastStatus).toBe("needs_review");expect(f.launch).not.toHaveBeenCalled();
 }));
 it("does not replay downtime or changed connections",async()=>fixture(async f=>{
  const missed=f.triggers.create(fields(f.workflowId),now-3600000);await f.service.tick(now+120000);expect(f.triggers.get(missed.id)?.lastStatus).toBe("skipped_missed");expect(f.launch).not.toHaveBeenCalled();const current=f.triggers.create({...fields(f.workflowId),reviewedModel:"other"},now-1000);await f.service.tick(now);expect(f.triggers.get(current.id)?.lastStatus).toBe("blocked");expect(f.triggers.get(current.id)?.enabled).toBe(false);expect(f.launch).not.toHaveBeenCalled();
 }));
 it("honors a pause while permissions are being checked and never launches",async()=>fixture(async f=>{
  const trigger=f.triggers.create(fields(f.workflowId),now-1000);f.validate.mockImplementationOnce(async()=>{f.triggers.update(trigger.id,{enabled:false,lastStatus:"paused"});return {model:"model",providerId:"provider"};});await f.service.tick(now);expect(f.launch).not.toHaveBeenCalled();expect(f.triggers.get(trigger.id)?.activeClaim).toBeUndefined();expect(f.triggers.get(trigger.id)?.lastStatus).toBe("paused");
 }));
 it("records unavailable authorization as blocked rather than prompting or launching",async()=>fixture(async f=>{
  const trigger=f.triggers.create(fields(f.workflowId),now-1000);f.validate.mockRejectedValueOnce(new Error("Target approval required."));await f.service.tick(now);expect(f.launch).not.toHaveBeenCalled();expect(f.triggers.get(trigger.id)?.lastStatus).toBe("blocked");expect(f.triggers.get(trigger.id)?.enabled).toBe(false);
 }));
 it("pins the connection when a paused schedule is first enabled",async()=>fixture(async f=>{
  const trigger=f.triggers.create({...fields(f.workflowId),enabled:false},now-1000);const url=new URL(`http://localhost/api/console/workflow-triggers/${trigger.id}`);expect((await f.service.handle("PATCH",url,{enabled:true,approval:"enable-reviewed-trigger"}))?.status).toBe(200);expect(f.triggers.get(trigger.id)?.reviewedModel).toBe("model");f.triggers.update(trigger.id,{nextFireAt:new Date(now).toISOString()});f.validate.mockResolvedValueOnce({model:"changed",providerId:"provider"});await f.service.tick(now);expect(f.launch).not.toHaveBeenCalled();expect(f.triggers.get(trigger.id)?.lastStatus).toBe("blocked");
 }));
 it("rejects a stale enable that finishes after a newer pause",async()=>fixture(async f=>{
  const trigger=f.triggers.create({...fields(f.workflowId),enabled:false},now-1000);const url=new URL(`http://localhost/api/console/workflow-triggers/${trigger.id}`);let finish!:(value:{model:string;providerId:string})=>void;f.validate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const enabling=f.service.handle("PATCH",url,{enabled:true,approval:"enable-reviewed-trigger"});await Promise.resolve();expect((await f.service.handle("PATCH",url,{enabled:false}))?.status).toBe(200);finish({model:"model",providerId:"provider"});expect((await enabling)?.status).toBe(409);expect(f.triggers.get(trigger.id)?.enabled).toBe(false);
 }));
 it("persists the reviewed account identity without exposing it through API responses",async()=>fixture(async f=>{
  f.validate.mockImplementationOnce(async()=>({model:"model",providerId:"provider",connectionIdentity:"private-account-hash"}));const url=new URL("http://localhost/api/console/workflow-triggers");const created=await f.service.handle("POST",url,{...fields(f.workflowId),approval:"enable-reviewed-trigger"});expect(created?.status).toBe(201);expect(JSON.stringify(created?.data)).not.toContain("private-account-hash");expect(f.triggers.list()[0]?.reviewedConnectionIdentity).toBe("private-account-hash");expect(JSON.stringify((await f.service.handle("GET",url,undefined))?.data)).not.toContain("private-account-hash");
 }));
 it("requires explicit enabled review and strict schedule fields",async()=>fixture(async f=>{
  const url=new URL("http://localhost/api/console/workflow-triggers");expect((await f.service.handle("POST",url,fields(f.workflowId)))?.status).toBe(400);expect((await f.service.handle("POST",url,{...fields(f.workflowId),approval:"enable-reviewed-trigger",cron:"* * * * *"}))?.status).toBe(400);expect((await f.service.handle("POST",url,{...fields(f.workflowId),approval:"enable-reviewed-trigger"}))?.status).toBe(201);
 }));
});

describe("chat schedule editing",()=>{
 it("creates paused drafts, edits timing without activation, and deletes through the scheduler",async()=>fixture(async f=>{
  const created=await f.service.invokeLifecycle("owner","create_schedule",{workflowId:f.workflowId,workflowRevision:1,cadence:"daily",startAt:new Date(now+3600000).toISOString(),timezone:"UTC"}) as {trigger:{id:string;enabled:boolean}};
  expect(created.trigger.enabled).toBe(false);
  expect(f.validate).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled();
  const changed=await f.service.invokeLifecycle("owner","update_schedule",{id:created.trigger.id,cadence:"weekly"}) as {trigger:{cadence:string;enabled:boolean}};
  expect(changed.trigger).toMatchObject({cadence:"weekly",enabled:false});
  const listed=await f.service.invokeLifecycle("owner","list_schedules",{}) as {schedules:unknown[]};expect(listed.schedules).toHaveLength(1);
  await expect(f.service.invokeLifecycle("other","delete_schedule",{id:created.trigger.id})).rejects.toThrow("not found");
  await f.service.invokeLifecycle("owner","delete_schedule",{id:created.trigger.id});expect(f.triggers.list()).toHaveLength(0);
 }));
 it("requires trusted activation review and enforces bound workflow membership",async()=>fixture(async f=>{
  const input={workflowId:f.workflowId,workflowRevision:1,cadence:"daily",startAt:new Date(now+3600000).toISOString(),timezone:"UTC",enabled:true};
  await expect(f.service.invokeLifecycle("owner","create_schedule",input)).rejects.toThrow("operator approval");
  const created=await f.service.invokeLifecycle("owner","create_schedule",input,{activationApproved:true}) as {trigger:{id:string;enabled:boolean}};expect(created.trigger.enabled).toBe(true);expect(f.validate).toHaveBeenCalledOnce();
  const changed=await f.service.invokeLifecycle("editor","update_schedule",{id:created.trigger.id,cadence:"weekly"},{workflowId:f.workflowId}) as {trigger:{enabled:boolean}};expect(changed.trigger.enabled).toBe(false);
  await expect(f.service.invokeLifecycle("editor","list_schedules",{workflowId:f.workflowId},{workflowId:"unrelated"})).rejects.toThrow("bound to another");
  await expect(f.service.invokeLifecycle("editor","update_schedule",{id:created.trigger.id,enabled:true},{workflowId:f.workflowId})).rejects.toThrow("operator approval");
  expect(f.launch).not.toHaveBeenCalled();
 }));
});
