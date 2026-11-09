import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostConsoleProcess, type HostConsoleProcessOptions } from "./host-console-process.js";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

const roots: string[] = [];
const controllers: HostConsoleProcess[] = [];
afterEach(async () => {
  const owned = controllers.splice(0);
  await Promise.allSettled(owned.map(controller => controller.forceStop()));
  // Failed assertions must not leave busy synthetic fixtures on the developer
  // machine. This fallback is test-only and verifies the exact private script.
  for (const controller of owned) {
    try {
      const row = execFileSync("ps", ["-p", String(controller.pid), "-o", "pgid=,command="], { encoding: "utf8" }).trim();
      const [group, ...command] = row.split(/\s+/);
      if (Number(group) === controller.pid && command.join(" ").includes(controller.options.args[0]!)) process.kill(-controller.pid, "SIGKILL");
    } catch { /* Already exited. */ }
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(overrides: Partial<HostConsoleProcessOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "0-host-execution-")); roots.push(root);
  const script = join(root, "session.mjs");
  writeFileSync(script, `
import { createReadStream, createWriteStream, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const input=createReadStream(null,{fd:3}); const output=createWriteStream(null,{fd:4});
const emit=f=>output.write(JSON.stringify(f)+'\\n');let buffered='';let state;
input.on('data',chunk=>{buffered+=chunk;let i;while((i=buffered.indexOf('\\n'))>=0){const f=JSON.parse(buffered.slice(0,i));buffered=buffered.slice(i+1);
if(f.type==='init'){if(f.value.startup){emit({type:'resource-begin',id:'startup-spawn-intent'});appendFileSync(f.value.path,'startup');if(f.value.startup==='reject')emit({type:'error',error:'synthetic startup failure'});continue;}state=f.value.state;emit({type:'snapshot',value:state});emit({type:'ready'});continue;}
if(f.type==='abort')continue;
if(f.type!=='request')continue;
if(f.op==='ping'){emit({type:'result',id:f.id,value:'healthy'});continue;}
if(f.op==='callback'){emit({type:'callback',id:'host-call',name:'fixture-write',args:[]});emit({type:'result',id:f.id,value:true});continue;}
if(f.op==='foreign'){emit({type:'resource-begin',id:'foreign-spawn'});emit({type:'resource',id:'foreign-spawn',pid:f.pid,group:true});emit({type:'result',id:f.id,value:true});continue;}
if(f.op==='child'){
emit({type:'resource-begin',id:'tool-spawn'});
const c=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'child\\\\n'),10)",f.path],{detached:true,stdio:'ignore'});
emit({type:'resource',id:'tool-spawn',pid:c.pid,group:true});emit({type:'result',id:f.id,value:c.pid});continue;
}
if(f.op==='creating'){
emit({type:'resource-begin',id:'unfinished-spawn'});
spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'unregistered\\\\n'),10)",f.path],{stdio:'ignore'});
emit({type:'result',id:f.id,value:true});continue;
}
if(f.op==='late-register'){
emit({type:'resource-begin',id:'late-spawn'});
const c=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'late\\\\n'),10)",f.path],{detached:true,stdio:'ignore'});
process.on('SIGTERM',()=>emit({type:'resource',id:'late-spawn',pid:c.pid,group:true}));
emit({type:'result',id:f.id,value:true});continue;
}
if(f.op==='hang'){
 process.on('SIGTERM',()=>{});emit({type:'snapshot',value:{...state,active:true}});
 if(f.mode==='busy'){output.write('',()=>{let last=0;for(;;){if(Date.now()-last>10){appendFileSync(f.path,'busy\\n');last=Date.now();}}});}
 else setInterval(()=>appendFileSync(f.path,'promise\\n'),10);
}
}});
`, { mode: 0o600 });
  const controller = new HostConsoleProcess({ command: process.execPath, args: [script], cwd: root, env: { PATH: process.env.PATH }, graceMs: 50, confirmationMs: 2000, ...overrides });
  controllers.push(controller);
  return { controller, root, sentinel: join(root, "sentinel") };
}

const mirror = {
  messages: [{ role: "user", content: "Retained operator message" }],
  workers: [{ id: "prior-worker", status: "completed" }], queuedMessages: [{ id: "queued", text: "Keep queued" }],
  usage: { inputTokens: 42, outputTokens: 7, costUsd: 0.01 },
  scope: { in_scope: ["https://fixture.invalid"] }, autonomyMode: "standard",
  selection: { providerId: "selected-provider", model: "selected-model", connectionIdentity: "selected-account" },
};

describe.skipIf(process.platform === "win32")("host session execution boundary", () => {
  it("keeps an uninterruptible host callback quarantined after worker exit rather than claiming its effects stopped", async () => {
    const gate = Promise.withResolvers<void>();
    const callback = vi.fn(async () => { await gate.promise; return true; });
    const f = fixture({ onCallback: callback, graceMs: 10, confirmationMs: 40 });
    try {
      await f.controller.start({ callbacks: ["fixture-write"] });
      await f.controller.request("callback");
      await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
      expect(await f.controller.forceStop()).toMatchObject({ processExited: true, resourcesStopped: false, quarantined: true });
      await expect(f.controller.request("ping")).rejects.toThrow(/fenced/);
    } finally { gate.resolve(); }
  });

  it("waits for a host callback to drain before confirming a clean stop", async () => {
    const gate = Promise.withResolvers<void>();
    const callback = vi.fn(async () => { await gate.promise; return true; });
    const f = fixture({ onCallback: callback });
    await f.controller.start({ callbacks: ["fixture-write"] });
    await f.controller.request("callback");
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    let settled = false;
    const stop = f.controller.forceStop().then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false);
    gate.resolve();
    expect(await stop).toEqual({ processExited: true, resourcesStopped: true, quarantined: false });
  });

  it.skipIf(!bunAvailable)("releases a Bun SQLite transaction lock after hard termination so another session can write", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-host-bun-db-")); roots.push(root);
    const script = join(root, "locked.mjs"); const database = join(root, "session.db");
    writeFileSync(script, `
import {Database} from 'bun:sqlite';import{createReadStream,writeSync}from'node:fs';
const input=createReadStream(null,{fd:3});const emit=f=>writeSync(4,JSON.stringify(f)+'\\n');let pending='';let db;
process.on('SIGTERM',()=>{});
input.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const f=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(f.type==='init'){emit({type:'ready'});continue;}if(f.type==='request'){db=new Database(${JSON.stringify(database)});db.exec("CREATE TABLE entries(value TEXT);BEGIN IMMEDIATE;INSERT INTO entries VALUES('uncommitted')");emit({type:'result',id:f.id,value:'locked'});}}});
`, { mode: 0o600 });
    const controller = new HostConsoleProcess({ command: "bun", args: [script], cwd: root, env: { PATH: process.env.PATH, HOME: root }, graceMs: 30 });
    controllers.push(controller);
    const other = fixture(); await other.controller.start({});
    await controller.start({}); expect(await controller.request("lock")).toBe("locked");
    expect(await controller.forceStop()).toEqual({ processExited: true, resourcesStopped: true, quarantined: false });
    const probe = execFileSync("bun", ["--eval", `const{Database}=require('bun:sqlite');const db=new Database(${JSON.stringify(database)});db.exec("PRAGMA busy_timeout=500;INSERT INTO entries VALUES('other-session')");console.log(JSON.stringify(db.query('SELECT value FROM entries').all()));db.close();`], { encoding: "utf8", timeout: 5000 });
    expect(JSON.parse(probe.trim())).toEqual([{ value: "other-session" }]);
    expect(existsSync(database + ".lock")).toBe(false);
    expect(await other.controller.request("ping")).toBe("healthy");
  });

  it.skipIf(!bunAvailable)("qualifies the Bun parent-to-worker FD transport and native database recovery together", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-host-bun-parent-")); roots.push(root);
    const bundle = join(root, "controller.mjs"); const worker = join(root, "worker.mjs"); const runner = join(root, "parent.mjs"); const database = join(root, "session.db");
    const { build } = await import("esbuild");
    await build({ entryPoints: [fileURLToPath(new URL("./host-console-process.ts", import.meta.url))], outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
    writeFileSync(worker, `
import{Database}from'bun:sqlite';import{createReadStream,writeSync}from'node:fs';
const input=createReadStream(null,{fd:3});const emit=f=>writeSync(4,JSON.stringify(f)+'\\n');let pending='',db;process.on('SIGTERM',()=>{});
input.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const f=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(f.type==='init'){emit({type:'snapshot',value:{messages:['retained'],usage:{inputTokens:7}}});emit({type:'ready'});}else if(f.type==='request'){db=new Database(${JSON.stringify(database)});db.exec("CREATE TABLE entries(value TEXT);BEGIN IMMEDIATE;INSERT INTO entries VALUES('uncommitted')");emit({type:'result',id:f.id,value:'locked'});}}});
`, { mode: 0o600 });
    writeFileSync(runner, `
import{HostConsoleProcess}from${JSON.stringify(bundle)};import{Database}from'bun:sqlite';
const c=new HostConsoleProcess({command:process.execPath,args:[${JSON.stringify(worker)}],cwd:${JSON.stringify(root)},env:{PATH:process.env.PATH,HOME:${JSON.stringify(root)}},graceMs:30});
try{await c.start({});await c.request('lock');const proof=await c.forceStop();const db=new Database(${JSON.stringify(database)});db.exec("PRAGMA busy_timeout=500;INSERT INTO entries VALUES('other-session')");const rows=db.query('SELECT value FROM entries').all();db.close();console.log(JSON.stringify({proof,rows,mirror:c.latestSnapshot}));}finally{await c.forceStop();}
`, { mode: 0o600 });
    const result = JSON.parse(execFileSync("bun", [runner], { encoding: "utf8", timeout: 10000 }).trim());
    expect(result).toMatchObject({ proof: { processExited: true, resourcesStopped: true, quarantined: false }, rows: [{ value: "other-session" }], mirror: { messages: ["retained"], usage: { inputTokens: 7 } } });
    expect(existsSync(database + ".lock")).toBe(false);
  });

  it.each(["promise", "busy"])("confirms termination of abort-ignoring %s work with no late writes and another session usable", async mode => {
    const first = fixture(); const other = fixture();
    await first.controller.start({ state: mirror }); await other.controller.start({ state: { messages: [] } });
    const pending = first.controller.request("hang", { mode, path: first.sentinel });
    const rejected = expect(pending).rejects.toThrow(/stopped/);
    await vi.waitFor(() => expect(existsSync(first.sentinel)).toBe(true));
    first.controller.abort();
    await new Promise(resolve => setTimeout(resolve, 40));
    const outcome = await first.controller.forceStop();
    expect(outcome).toEqual({ processExited: true, resourcesStopped: true, quarantined: false });
    await rejected;
    const after = readFileSync(first.sentinel, "utf8");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(readFileSync(first.sentinel, "utf8")).toBe(after);
    expect(first.controller.latestSnapshot).toEqual({ ...mirror, active: true });
    await expect(first.controller.request("ping")).rejects.toThrow(/fenced/);
    expect(await other.controller.request("ping")).toBe("healthy");
  });

  it("confirms registered detached tool children are gone before declaring a clean stop", async () => {
    const f = fixture(); await f.controller.start({ state: mirror });
    const pid = await f.controller.request("child", { path: f.sentinel }) as number;
    await vi.waitFor(() => expect(existsSync(f.sentinel)).toBe(true));
    expect(pid).toBeGreaterThan(1);
    expect(await f.controller.forceStop()).toEqual({ processExited: true, resourcesStopped: true, quarantined: false });
    const after = readFileSync(f.sentinel, "utf8");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(readFileSync(f.sentinel, "utf8")).toBe(after);
  });

  it("quarantines unowned resource claims and never signals a different session", async () => {
    const f = fixture(); const foreign = fixture();
    await f.controller.start({ state: mirror }); await foreign.controller.start({});
    await f.controller.request("foreign", { pid: foreign.controller.pid });
    expect(await f.controller.forceStop()).toMatchObject({ processExited: true, resourcesStopped: false, quarantined: true });
    expect(await foreign.controller.request("ping")).toBe("healthy");
    await expect(f.controller.request("ping")).rejects.toThrow(/fenced/);
  });

  it("quarantines an interrupted resource creation even after the session process is confirmed dead", async () => {
    const f = fixture(); await f.controller.start({ state: mirror });
    await f.controller.request("creating", { path: f.sentinel });
    await vi.waitFor(() => expect(existsSync(f.sentinel)).toBe(true));
    expect(await f.controller.forceStop()).toMatchObject({ processExited: true, resourcesStopped: false, quarantined: true });
    const after = readFileSync(f.sentinel, "utf8");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(readFileSync(f.sentinel, "utf8")).toBe(after);
    await expect(f.controller.request("ping")).rejects.toThrow(/fenced/);
  });

  it("accepts resource registration while draining and kills the newly registered detached group", async () => {
    const f = fixture(); await f.controller.start({ state: mirror });
    await f.controller.request("late-register", { path: f.sentinel });
    await vi.waitFor(() => expect(existsSync(f.sentinel)).toBe(true));
    expect(await f.controller.forceStop()).toEqual({ processExited: true, resourcesStopped: true, quarantined: false });
    const after = readFileSync(f.sentinel, "utf8");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(readFileSync(f.sentinel, "utf8")).toBe(after);
  });
});


describe.skipIf(process.platform === "win32")("startup resource ownership", () => {
  it.each(["pending", "reject"])("retains unresolved creation intent through %s readiness and confirms no false clean stop", async startup => {
    const f = fixture();
    const starting = f.controller.start({ startup, path: f.sentinel });
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(existsSync(f.sentinel)).toBe(true));
    expect(await f.controller.forceStop()).toMatchObject({ processExited: true, resourcesStopped: false, quarantined: true });
    await rejected;
    await expect(f.controller.request("ping")).rejects.toThrow();
  });
});
