import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect} from "vitest";
import {WorkflowTriggerStore,nextWorkflowTriggerFire} from "./workflow-triggers.js";
const start = "2026-09-30T12:00:00.000Z";
const fields = {workflowId:"workflow",workflowRevision:2,sessionId:"session",cadence:"hourly" as const,startAt:start,timezone:"UTC",enabled:true};
describe("durable schedule claims",()=>{
 it("anchors intervals and skips a missed burst",()=>{ expect(nextWorkflowTriggerFire(start,"hourly",Date.parse("2026-09-30T15:20:00Z"))).toBe("2026-09-30T16:00:00.000Z"); });
 it("keeps a paused schedule paused when its active execution finishes",()=>{
 const store=new WorkflowTriggerStore(":memory:");try{const trigger=store.create(fields,Date.parse(start)-1000);const claim=store.claim(trigger.id,Date.parse(start))!;expect(store.delete(trigger.id)).toBe(false);store.update(trigger.id,{enabled:false,lastStatus:"paused"});store.release(trigger.id,claim.activeClaim!,{lastStatus:"completed"});expect(store.get(trigger.id)?.enabled).toBe(false);expect(store.get(trigger.id)?.lastStatus).toBe("paused");expect(store.delete(trigger.id)).toBe(true);}finally{store.close();}
 });
 it("claims once across independent engines and blocks overlap until release",()=>{
  const dir=mkdtempSync(join(tmpdir(),"zero-trigger-"));const path=join(dir,"control.db");const first=new WorkflowTriggerStore(path);const second=new WorkflowTriggerStore(path);
  try { const trigger=first.create(fields,Date.parse(start)-1000);const claim=first.claim(trigger.id,Date.parse(start));expect(claim?.activeClaim).toBeTruthy();expect(second.claim(trigger.id,Date.parse(start))).toBeNull();expect(second.claim(trigger.id,Date.parse(start)+7200000)).toBeNull();expect(second.release(trigger.id,"wrong",{lastStatus:"completed"})).toBeNull();first.release(trigger.id,claim!.activeClaim!,{lastStatus:"completed"});expect(second.claim(trigger.id,Date.parse(start)+3600000)?.activeClaim).toBeTruthy();expect(second.get(trigger.id)?.workflowRevision).toBe(2); }
  finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
 });
});
