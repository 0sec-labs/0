import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

it.skipIf(process.platform === "win32" || !bunAvailable)("qualifies Bun gateway → real worker → owned tool → force stop → same chat continuation", async () => {
  const root = mkdtempSync(join(tmpdir(), "0-gateway-host-"));
  const repository = fileURLToPath(new URL("../../../..", import.meta.url));
  const entry = join(root, "qualification.ts"), sentinel = join(root, "effects");
  const aliases = Object.fromEntries(["core", "db", "shared", "templates", "llm-redteam"].map(name => [`@0/${name}`, resolve(repository, `packages/${name}/src/index.ts`)]));
  writeFileSync(entry, `
import{existsSync,readFileSync}from'node:fs';import assert from'node:assert/strict';

const root=${JSON.stringify(root)},sentinel=${JSON.stringify(sentinel)};
// Installed independently in both processes. No real fetch remains reachable.
globalThis.fetch=async(url,init)=>{const body=init?.body?JSON.parse(String(init.body)):{};
 if(String(url).endsWith('/models'))return Response.json({data:[{id:'gpt-fixture'},{id:'gpt-fixture-two'}]});
 assert.equal(String(url),'https://api.openai.com/v1/responses');
 const transcript=JSON.stringify(body.input??[]),hang=transcript.includes('OWNED-HANG')&&!transcript.includes('CONTINUE-SAFELY');
 if(transcript.includes('PROGRAM-BLUE')&&!transcript.includes('PROGRAM-CLEAR'))assert.equal(body.access_programs?.cyber,'daybreak_blue');
 if(transcript.includes('PROGRAM-CLEAR'))assert.equal(body.access_programs,undefined);
 if(transcript.includes('MODEL-TWO'))assert.equal(body.model,'gpt-fixture-two');
 if(transcript.includes('ACCOUNT-B'))assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-reconnected');
 if(transcript.includes('CONTINUE-SAFELY')){assert(transcript.includes('owned-tool'));assert(transcript.includes('interrupted'));assert(transcript.includes('function_call_output'));}
 const output=hang?[{type:'function_call',call_id:'owned-tool',name:'bash',arguments:JSON.stringify({command:${JSON.stringify(`trap '' TERM; while true; do printf x >> '${sentinel}'; sleep 0.02; done`)},timeout:60000})}]:[{type:'message',content:[{type:'output_text',text:'Continued safely'}]}];
 return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'synthetic',status:'completed',output,...(body.access_programs?{access_programs:body.access_programs}:{}),usage:{input_tokens:7,output_tokens:2}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}})};
if(process.argv.includes('--host-console-worker')){await(await import(${JSON.stringify(resolve(repository, "packages/cli/src/host-console-worker.ts"))})).runHostConsoleWorker()}
else{
 const{ConsoleGateway}=await import(${JSON.stringify(resolve(repository, "packages/cli/src/web/console-gateway.ts"))});const{osecDB}=await import('@0/db');
 const g=new ConsoleGateway({homeDir:root,projectPath:root,dbPath:root+'/selected.db'});
 process.once('SIGTERM',()=>{void g.closeAll().finally(()=>process.exit(1))});
 const wait=async(check)=>{const end=Date.now()+15000;while(!check()){if(Date.now()>end)throw Error('qualification timed out: '+JSON.stringify(g.list()));await Bun.sleep(20)}};
 const runtime={providerId:'openai',model:'gpt-fixture',singleModel:true,cyberAccessProgram:'daybreak_blue'};
 const chat=g.create({title:'Retain chat',autonomyMode:'yolo',runtime}),other=g.create({title:'Other chat',runtime});
 try{await g.send(chat.id,'OWNED-HANG');await wait(()=>existsSync(sentinel));
 await g.send(chat.id,{text:'Retain queued message',mode:'queue'});assert.equal((await g.forceStop(chat.id)).status,'ready');
 const after=readFileSync(sentinel,'utf8');await Bun.sleep(150);assert.equal(readFileSync(sentinel,'utf8'),after);
 assert.equal(g.get(chat.id).session.runtime.accessProgram.requested,'daybreak_blue');
 assert.equal(g.get(chat.id).queuedMessages.length,1);assert.equal(g.get(chat.id).usage.costUnavailable,true);
 await g.send(other.id,'OTHER-HEALTHY');await wait(()=>g.get(other.id).session.status==='ready');
 await g.send(chat.id,'CONTINUE-SAFELY');await wait(()=>g.get(chat.id).session.status==='ready');
 const continued=g.get(chat.id);assert.equal(continued.session.id,chat.id);assert.equal(readFileSync(sentinel,'utf8'),after);
 const messages=JSON.stringify(continued.messages);assert(messages.includes('OWNED-HANG'));assert(messages.includes('Continued safely'));assert(messages.includes('Retain queued message'));
 await g.setRuntime(chat.id,{cyberAccessProgram:'daybreak_blue'});
 await g.send(chat.id,'PROGRAM-BLUE');await wait(()=>g.get(chat.id).session.status==='ready');
 assert.equal(g.get(chat.id).session.runtime.accessProgram.requested,'daybreak_blue');
 assert.equal(g.get(chat.id).session.runtime.accessProgram.confirmed,'daybreak_blue');
 await g.setRuntime(chat.id,{cyberAccessProgram:null});
 await g.send(chat.id,'PROGRAM-CLEAR');await wait(()=>g.get(chat.id).session.status==='ready');
 await g.setRuntime(chat.id,{model:'gpt-fixture-two'});
 await g.send(chat.id,'MODEL-TWO');await wait(()=>g.get(chat.id).session.status==='ready');
 await g.reloadConnection(chat.id);
 process.env.OPENAI_API_KEY='synthetic-reconnected';await g.reloadConnection(chat.id);
 await g.send(chat.id,'ACCOUNT-B');await wait(()=>g.get(chat.id).session.status==='ready');
 assert.equal(readFileSync(sentinel,'utf8'),after);
 const db=new osecDB(root+'/selected.db');assert.equal(db.getScan(chat.id)?.status,'failed');db.close();
 console.log(JSON.stringify({ok:true,retainedQueue:true,remainingQueue:continued.queuedMessages.length}));
 }finally{await g.closeAll()}}
`);
  const bundle = join(repository, "packages/cli", `.host-worker-qualification-${Date.now()}.mjs`);
  const { build } = await import("esbuild");
  try {
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, packages: "external", alias: aliases, platform: "node", format: "esm", external: ["bun", "./tree-sitter-compiled/*"], plugins: [{ name: "qualified-dependency-paths", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path.startsWith("@0/") || args.path.startsWith("node:") || args.path === "bun") return;
      try { return { path: createRequire(import.meta.url).resolve(args.path, { paths: [dirname(args.importer)] }), external: true }; } catch { return; }
    });
  } }], logLevel: "silent" });
    const result = await promisify(execFile)("bun", [bundle], { cwd: repository, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_WIRE_API: "responses", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "", ZERO_DISABLE_HUNT_MEMORY: "1", ZERO_NO_TELEMETRY: "1", ZERO_JEV_FEATURES: "", ZERO_0VERSE_MCP: "0" },
    });
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({ ok: true, retainedQueue: true, remainingQueue: 0 });
  } finally { rmSync(bundle, { force: true }); rmSync(root, { recursive: true, force: true }); }
}, 65_000);
