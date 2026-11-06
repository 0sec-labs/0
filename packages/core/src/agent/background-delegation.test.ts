import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "./tools.js";
import type { ToolContext } from "./types.js";
import type { NativeRuntime } from "../runtime/types.js";
import { eventBus, type SubagentLifecyclePayload } from "../events/bus.js";
import { drainInbox, peekInbox } from "../hub/mailbox.js";

const homes: string[] = [];
const executors: ToolExecutor[] = [];
async function runtime(): Promise<NativeRuntime> {
  return { type: "api", isAvailable: async () => true,
    executeNative: async () => ({ content: [], stopReason: "end_turn", durationMs: 0 }) };
}
function executor(loop: (opts: any) => Promise<any>, overrides: Partial<ToolContext> = {}) {
  const home = mkdtempSync(join(tmpdir(), "0-background-delegation-")); homes.push(home);
  const context = { target: "https://target.test", scanId: `parent-${homes.length}`,
    findings: [], attackResults: [], targetInfo: {}, consoleSession: true,
    agentMessaging: { selfId: "Main", selfRole: "parent", siblingChannelEnabled: true,
      operatorChannelEnabled: false, projectPath: process.cwd(), homeDir: home }, ...overrides } as ToolContext;
  const tools = new ToolExecutor(context, undefined, undefined, runtime);
  vi.spyOn(tools as any, "loadSubagentDeps").mockResolvedValue({ runNativeAgentLoop: loop });
  executors.push(tools);
  return { tools, home };
}
const done = (summary = "Evidence checked") => ({ findings: [], turnCount: 1, summary, done: true });
afterEach(async () => {
  for (const tools of executors.splice(0)) await tools.cleanup();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); eventBus.clear();
});

describe("canonical background delegation", () => {
  it("returns before completion, survives parent interruption, delivers and accepts a follow-up on the same id", async () => {
    let finish!: () => void;
    const runs: any[] = [];
    const { tools, home } = executor(async opts => {
      runs.push(opts);
      if (runs.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      return done();
    });
    const parent = new AbortController();
    const result = await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect source", name: "Inspector" } }, { signal: parent.signal });
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ background: true, name: "Inspector" });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    parent.abort();
    expect(runs[0].signal.aborted).toBe(false);
    expect(runs[0].config.maxTurns).toBeUndefined();
    finish();
    await vi.waitFor(() => expect(drainInbox(process.cwd(), "Main", home)).toHaveLength(1));
    const id = (result.output as any).agent_id;
    const followup = await tools.execute({ name: "spawn_agent", arguments: { agent_id: id, task: "Inspect the next file" } });
    expect(followup.output).toMatchObject({ agent_id: id, continued: true });
    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 3000 });
    expect(runs[1].config.scanId).toBe(id);
    expect(runs[1].config.systemPrompt).toContain("Inspect the next file");
    expect(runs[1].config.systemPrompt).toContain("Evidence checked");
    expect(runs[1].config.systemPrompt).toContain("Inspect source");
  });

  it("bounds background batches across separate calls and never dispatches stopped queued agents", async () => {
    vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
    const runs: any[] = [];
    const lifecycle: SubagentLifecyclePayload[] = [];
    eventBus.subscribe({ emit: (name, payload) => { if (name === "subagent_lifecycle") lifecycle.push(payload as SubagentLifecyclePayload); } });
    const { tools } = executor(async opts => {
      runs.push(opts);
      await new Promise<void>(resolve => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      opts.signal.throwIfAborted();
      return done();
    });
    const first = await tools.execute({ name: "spawn_agent", arguments: { tasks: [{ task: "A" }, { task: "B" }], context: "Shared contract" } });
    await tools.execute({ name: "spawn_agent", arguments: { task: "C" } });
    expect(first.output).toMatchObject({ spawned: 2, background: true });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].config.systemPrompt).toContain("Shared contract");
    expect(lifecycle.filter(e => e.status === "queued")).toHaveLength(3);
    await tools.stopPersistentAgents();
    expect(runs).toHaveLength(1);
    expect(lifecycle.filter(e => e.status === "stopped")).toHaveLength(3);
  });

  it("delivers every completion when a batch exceeds the mailbox retention limit", async () => {
    const { tools, home } = executor(async opts => done(opts.config.scanId));
    const result = await tools.execute({ name: "spawn_agent", arguments: {
      tasks: Array.from({ length: 257 }, (_, i) => ({ task: `Inspect item ${i}` })),
    } });
    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(peekInbox(process.cwd(), "Main", home)).toHaveLength(256));
    const first = drainInbox(process.cwd(), "Main", home);
    await vi.waitFor(() => expect(peekInbox(process.cwd(), "Main", home)).toHaveLength(1), { timeout: 3000 });
    const last = drainInbox(process.cwd(), "Main", home);
    expect(new Set([...first, ...last].map(message => message.from)).size).toBe(257);
  });

  it("validates the entire batch and workspace before registering any child", async () => {
    const loop = vi.fn(async () => done()); const { tools } = executor(loop);
    const events: unknown[] = [];
    eventBus.subscribe({ emit: (type, payload) => { if (type === "subagent_lifecycle") events.push(payload); } });
    for (const arguments_ of [
      { task: "A", tasks: [{ task: "B" }] },
      { tasks: [{ task: "A" }, { task: "" }] },
      { task: "A", wait: "false" },
      { task: "A", max_turns: -1 },
      { tasks: [{ task: "A" }, { task: "B", expected_workspace: { path: "/different/repo", head: "abc" } }] },
    ]) expect((await tools.execute({ name: "spawn_agent", arguments: arguments_ })).success).toBe(false);
    expect(events).toEqual([]); expect(loop).not.toHaveBeenCalled();
  });

  it("rejects cross-session follow-ups and attempts to change a worker's authority", async () => {
    const first = executor(async () => done());
    const second = executor(async () => done());
    const result = await first.tools.execute({ name: "spawn_agent", arguments: { task: "Inspect source" } });
    const id = (result.output as any).agent_id;
    expect((await second.tools.execute({ name: "spawn_agent", arguments: { agent_id: id, task: "Foreign follow-up" } })).success).toBe(false);
    expect((await first.tools.execute({ name: "spawn_agent", arguments: { agent_id: id, task: "Change scope", expected_workspace: { path: "/tmp/other", head: "abc" } } })).success).toBe(false);
    expect((await first.tools.execute({ name: "spawn_agent", arguments: { agent_id: id, task: "Change model", model: "unapproved" } })).success).toBe(false);
  });

  it("preserves an explicit host limit above the former silent ceiling", async () => {
    const runs: any[] = [];
    const { tools } = executor(async opts => { runs.push(opts); return done(); });
    const result = await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect source", max_turns: 200 } });
    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].config.maxTurns).toBe(200);
  });

  it("uses blocking execution outside a console and refuses explicit background without a delivery route", async () => {
    const loop = vi.fn(async () => done());
    const { tools } = executor(loop, { consoleSession: false, agentMessaging: undefined } as any);
    const blocked = await tools.execute({ name: "spawn_agent", arguments: { task: "A", wait: false } });
    expect(blocked.success).toBe(false); expect(loop).not.toHaveBeenCalled();
    const result = await tools.execute({ name: "spawn_agent", arguments: { task: "A" } });
    expect(result.output).toMatchObject({ summary: "Evidence checked", done: true });
    expect(loop).toHaveBeenCalledTimes(1);
  });
});
