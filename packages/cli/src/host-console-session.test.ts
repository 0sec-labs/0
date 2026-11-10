import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, ScopePolicy, type NativeMessage } from "@0/core";
import { createHostConsoleSession, hostConsoleSessionSupport } from "./host-console-session.js";
import { HostConsoleFrameReader, encodeHostConsoleFrames } from "./host-console-protocol.js";

function runtime() {
  return new LlmApiRuntime({ type: "api", timeout: 1000, provider: "openai", model: "fixture-selected-model", env: {
    OPENAI_API_KEY: "synthetic-not-a-real-provider-key", ZERO_SKIP_PROVIDER_BANNER: "1",
  } });
}

describe("host session protocol", () => {
  it("round-trips a large Unicode snapshot without truncation", () => {
    const original = { type: "snapshot", value: "雪🌒".repeat(2_000_000) };
    const received: unknown[] = [];
    const reader = new HostConsoleFrameReader();
    for (const frame of encodeHostConsoleFrames(original)) {
      reader.push(frame.slice(0, 33), value => received.push(value));
      reader.push(frame.slice(33), value => received.push(value));
    }
    expect(received).toEqual([original]);
  });

  it("rejects an out-of-order chunk instead of publishing a partial snapshot", () => {
    const reader = new HostConsoleFrameReader();
    expect(() => reader.push(JSON.stringify({ type: "chunk", id: "broken", index: 1, total: 2, data: "e30=" }) + "\n", () => {})).toThrow(/assembly/);
  });
});

describe.skipIf(process.platform === "win32")("host session facade", () => {
  const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
  beforeEach(() => {
    // These facade fixtures run no DB/runtime code in the child. Real Bun
    // database termination is qualified separately in the controller suite.
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "synthetic-transport-test" });
  });
  afterEach(() => {
    if (bunVersion) Object.defineProperty(process.versions, "bun", bunVersion);
    else delete process.versions.bun;
  });
  it("recovers a confirmed interrupted tool with paired history and never replays its call", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-host-session-"));
    const script = join(root, "fixture.mjs"); const sentinel = join(root, "writes");
    writeFileSync(script, `
import { createReadStream,createWriteStream,appendFileSync } from 'node:fs';
const earlyFlag=process.env.ZERO_DISABLE_HUNT_MEMORY;
const input=createReadStream(null,{fd:3}),output=createWriteStream(null,{fd:4});const emit=f=>output.write(JSON.stringify(f)+'\\n');let pending='',state;
input.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const f=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);
if(f.type==='init'){const b=f.value;state={scanId:b.sessionId,systemPrompt:'fixture',tools:[],messages:b.config.initialMessages??[],autonomyMode:b.config.autonomyMode,target:b.config.target,webSearchEnabled:true,bindingIdentity:b.runtime.binding.identity,policyFlag:b.executionEnvironment.ZERO_DISABLE_HUNT_MEMORY,earlyFlag};emit({type:'snapshot',value:state});emit({type:'ready'});continue;}
if(f.type==='abort')continue;if(f.type!=='request')continue;
if(f.op==='send'){state.messages.push({role:'user',content:[{type:'text',text:f.text}]});
if(f.text==='hang'){emit({type:'event',name:'onAssistantDelta',args:['Partial response']});emit({type:'event',name:'onUsage',args:[{inputTokens:17,outputTokens:5,turnTokensUsed:22,turnTokenBudget:1000,maxToolIterations:10,iterations:1,kind:'planner'}]});state.messages.push({role:'assistant',content:[{type:'text',text:'Partial response'},{type:'tool_use',id:'interrupted-tool-17',name:'fixture_tool',input:{}}]});state.active=true;emit({type:'snapshot',value:state});process.on('SIGTERM',()=>{});setInterval(()=>appendFileSync(${JSON.stringify(sentinel)},'effect\\n'),10);continue;}
state.messages.push({role:'assistant',content:[{type:'text',text:'Continued safely'}]});state.active=false;emit({type:'snapshot',value:state});emit({type:'result',id:f.id,value:{assistantText:'Continued safely',stopReason:'end_turn',toolCalls:[],usage:{inputTokens:7,outputTokens:2},budget:{tokensUsed:9}}});continue;}
if(f.op==='close'){emit({type:'result',id:f.id});process.exit(0);}
}});
`, { mode: 0o600 });
    const selected = runtime();
    const execute = vi.spyOn(selected, "executeNative");
    const scope = ScopePolicy.fromJson({ in_scope: ["fixture.invalid"] });
    const initial: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Preserve earlier context" }] }];
    const options = { config: { runtime: selected, scanId: "host-fixture", initialMessages: initial, scope, autonomyMode: "standard" as const, target: "https://fixture.invalid" },
      executionEnvironment: { ZERO_DISABLE_HUNT_MEMORY: "1" },
      launch: { command: process.execPath, args: [script], cwd: root, env: { PATH: process.env.PATH }, graceMs: 30 } };
    const first = createHostConsoleSession(options);
    let next: ReturnType<typeof createHostConsoleSession> | undefined;
    try {
      await first.ready;
      expect(first.executionProcess.latestSnapshot).toMatchObject({ policyFlag: "1", earlyFlag: "1" });
      const request = first.send("hang");
      await vi.waitFor(() => expect(existsSync(sentinel)).toBe(true));
      const original = structuredClone(first.messages);
      expect(await first.forceStop()).toMatchObject({ processExited: true, resourcesStopped: true, quarantined: false });
      expect(await request).toMatchObject({ stopReason: "cancelled", assistantText: "Partial response", usage: { inputTokens: 17, outputTokens: 5 }, budget: { tokensUsed: 22, iterations: 1 }, error: expect.stringContaining("unpriced") });
      expect(first.messages.slice(0, original.length)).toEqual(original);
      expect(first.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "interrupted-tool-17", is_error: true }] });
      expect(first.scope).toBe(scope);
      const after = readFileSync(sentinel, "utf8");
      next = createHostConsoleSession({ ...options, config: { ...options.config, initialMessages: first.messages } });
      await next.ready;
      expect(next.executionProcess.latestSnapshot).toMatchObject({ bindingIdentity: selected.connectionIdentity() });
      expect((await next.send("continue")).assistantText).toBe("Continued safely");
      expect(next.messages.filter(message => message.content.some(block => block.type === "tool_use"))).toHaveLength(1);
      expect(readFileSync(sentinel, "utf8")).toBe(after);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([first.cleanup(), next?.cleanup()]);
      for (const session of [first, next]) if (session) {
        try {
          // This fixture owns only its dedicated process group. Keep failures
          // from leaving synthetic writes alive after the test has returned.
          const pid = session.executionProcess.pid;
          const row = execFileSync("ps", ["-p", String(pid), "-o", "pgid=,command="], { encoding: "utf8" }).trim();
          const [group, ...command] = row.split(/\s+/);
          if (Number(group) === pid && command.join(" ").includes(script)) process.kill(-pid, "SIGKILL");
        } catch { /* Already exited. */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses oversized captured history before launching a process", () => {
    const config = { runtime: runtime(), scanId: "oversized", initialMessages: [{ role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(9 * 1024 * 1024) }] }] };
    expect(hostConsoleSessionSupport(config).supported).toBe(false);
    expect(() => createHostConsoleSession({ config, launch: { command: "/nonexistent", args: [], cwd: tmpdir(), env: {} } })).toThrow(/frame exceeds/);
  });

  it("marks injected custom live stores unsupported unless the caller supplies a proven backing path", () => {
    const config = { runtime: runtime(), scanId: "custom-store", learningStore: {} as NonNullable<Parameters<typeof createHostConsoleSession>[0]["config"]["learningStore"]> };
    expect(hostConsoleSessionSupport(config).supported).toBe(false);
    expect(hostConsoleSessionSupport(config, { learningDbPath: join(tmpdir(), "explicit-known-backing.db") }).supported).toBe(true);
  });

  it("keeps enabled Jev capabilities in-process instead of dropping their private authorization", () => {
    const config = { runtime: runtime(), scanId: "jev-capabilities" };
    const executionEnvironment = { ZERO_JEV_FEATURES: "browser,memory" };
    expect(hostConsoleSessionSupport(config, { executionEnvironment })).toMatchObject({ supported: false, reason: expect.stringContaining("Jev") });
    expect(() => createHostConsoleSession({ config, executionEnvironment, launch: { command: "/nonexistent", args: [], cwd: tmpdir(), env: {} } })).toThrow(/Jev/);
  });

  it.each([undefined, "", "false", "unknown"])("preserves existing disabled Jev behavior for %s even with credentials", flag => {
    const executionEnvironment = { ...(flag === undefined ? {} : { ZERO_JEV_FEATURES: flag }), AI_GATEWAY_API_KEY: "synthetic", ZERO_JEV_CLOUD_TOKEN: "synthetic" };
    expect(hostConsoleSessionSupport({ runtime: runtime(), scanId: "jev-disabled" }, { executionEnvironment }).supported).toBe(true);
  });

  it("keeps Node/WASM execution in-process rather than advertising confirmed force stop", () => {
    delete process.versions.bun;
    expect(hostConsoleSessionSupport({ runtime: runtime(), scanId: "node-wasm" })).toMatchObject({ supported: false, reason: expect.stringContaining("WASM") });
  });
});
