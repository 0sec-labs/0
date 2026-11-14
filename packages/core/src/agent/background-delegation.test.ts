import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditWorkerTree } from "./worker-tree.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
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
    // These lifecycle fixtures perform source review, not checkout edits.
    delegationTools: [TOOL_DEFINITIONS.read_file, TOOL_DEFINITIONS.done, TOOL_DEFINITIONS.spawn_agent, TOOL_DEFINITIONS.spawn_agents, TOOL_DEFINITIONS.spawn_persistent_agent],
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

  it("transitions a revived worker to queued while awaiting queue capacity and re-parks upon completion", async () => {
    vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
    const lifecycle: SubagentLifecyclePayload[] = [];
    eventBus.subscribe({
      emit: (name, payload) => {
        if (name === "subagent_lifecycle") lifecycle.push({ ...(payload as SubagentLifecyclePayload) });
      },
    });

    let blockerRelease!: () => void;
    const blockerGate = new Promise<void>(resolve => { blockerRelease = resolve; });
    let blockerStartedResolve!: () => void;
    const blockerStartedPromise = new Promise<void>(r => { blockerStartedResolve = r; });

    let reviveStartedResolve!: () => void;
    const reviveStartedPromise = new Promise<void>(r => { reviveStartedResolve = r; });
    let reviveRelease!: () => void;
    const reviveGate = new Promise<void>(r => { reviveRelease = r; });

    const { tools, home } = executor(async opts => {
      const task = opts.config.systemPrompt;
      if (task.includes("Worker 1 follow-up")) {
        reviveStartedResolve();
        await reviveGate;
        return done("W1 follow-up done");
      }
      if (task.includes("Worker 1 initial")) return done("W1 initial");
      if (task.includes("Blocker task")) {
        blockerStartedResolve();
        await blockerGate;
        return done("Blocker done");
      }
      return done();
    });

    const w1 = await tools.execute({ name: "spawn_agent", arguments: { task: "Worker 1 initial", name: "Worker1" } });
    const w1Id = (w1.output as any).agent_id;
    await vi.waitFor(() => {
      const last = lifecycle.filter(e => e.agent_id === w1Id).at(-1);
      expect(last?.status).toBe("parked");
    });

    const blocker = await tools.execute({ name: "spawn_agent", arguments: { task: "Blocker task", name: "Blocker" } });
    const blockerId = (blocker.output as any).agent_id;
    await blockerStartedPromise;
    await vi.waitFor(() => {
      const last = lifecycle.filter(e => e.agent_id === blockerId).at(-1);
      expect(last?.status).toBe("running");
    });

    drainInbox(process.cwd(), "Main", home);

    const followup = await tools.execute({ name: "spawn_agent", arguments: { agent_id: w1Id, task: "Worker 1 follow-up" } });
    expect(followup.success).toBe(true);

    await vi.waitFor(() => {
      const last = lifecycle.filter(e => e.agent_id === w1Id).at(-1);
      expect(last?.status).toBe("queued");
    });

    blockerRelease();
    await reviveStartedPromise;
    await vi.waitFor(() => {
      const last = lifecycle.filter(e => e.agent_id === w1Id).at(-1);
      expect(last?.status).toBe("running");
    });

    reviveRelease();
    await vi.waitFor(() => {
      const last = lifecycle.filter(e => e.agent_id === w1Id).at(-1);
      expect(last?.status).toBe("parked");
    });

    const w1Events = lifecycle.filter(e => e.agent_id === w1Id).map(e => e.status);
    expect(w1Events).toEqual(["queued", "running", "parked", "queued", "running", "parked"]);
    await tools.stopPersistentAgents();
  });
});


describe("single delegation surface management", () => {
  it("lists and stops actual owned workers even at admission capacity without event delivery", async () => {
    vi.stubEnv("ZERO_SUBAGENT_MAX_WORKERS", "1");
    const { tools } = executor(async opts => {
      await new Promise<void>(resolve => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      opts.signal.throwIfAborted();
      return done();
    });
    const spawn = await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect" } });
    const id = (spawn.output as any).agent_id;
    eventBus.clear();
    const listed = await tools.execute({ name: "spawn_agent", arguments: { op: "list" } });
    expect(listed.output).toMatchObject({ live: 1, retainedTerminal: 0 });
    expect((listed.output as any).workers.map((worker: any) => worker.id)).toEqual([id]);
    const got = await tools.execute({ name: "spawn_agent", arguments: { op: "get", agent_id: id } });
    expect(got.output).toMatchObject({ worker: { id, live: true, effects: "unknown" } });
    const stopped = await tools.execute({ name: "spawn_agent", arguments: { op: "stop", agent_id: id } });
    expect(stopped.output).toMatchObject({ worker: { id, status: "stopped", live: false, cleanup: "drained" }, cleanupDrained: true });
    expect((await tools.execute({ name: "spawn_agent", arguments: { op: "list" } })).output).toMatchObject({ live: 0, retainedTerminal: 1 });
  });
  it("manages descendants not directly spawned by this executor and refuses foreign/self ids", async () => {
    const tree = new AuditWorkerTree("root");
    const { tools } = executor(async () => done(), { scanId: "root", workerTree: tree });
    const parent = tree.acquire("parent", "root");
    const descendant = tree.acquire("descendant", "parent");
    descendant.signal.addEventListener("abort", descendant.release);
    parent.signal.addEventListener("abort", parent.release);
    expect((await tools.execute({ name: "spawn_agent", arguments: { op: "get", agent_id: "descendant" } })).success).toBe(true);
    expect((await tools.execute({ name: "spawn_agent", arguments: { op: "stop", agent_id: "foreign" } })).success).toBe(false);
    expect((await tools.execute({ name: "spawn_agent", arguments: { op: "stop", agent_id: "root" } })).success).toBe(false);
    expect((await tools.execute({ name: "spawn_agent", arguments: { op: "list", task: "Do not spawn" } })).success).toBe(false);
    const stopped = await tools.execute({ name: "spawn_agent", arguments: { op: "stop_all" } });
    expect(stopped.output).toMatchObject({ live: 0, retainedTerminal: 2, counts: { stopped: 2 } });
    await tree.close();
  });
});

it("stops descendants of a completed retained parent before claiming subtree cleanup", async () => {
  const tree = new AuditWorkerTree("root");
  const { tools } = executor(async () => done(), { scanId: "root", workerTree: tree });
  const parent = tree.acquire("completed-parent", "root");
  const grandchild = tree.acquire("grandchild", "completed-parent");
  tree.observeLifecycle({ agent_id: "completed-parent", status: "completed", done: true });
  parent.release();
  const get = await tools.execute({ name: "spawn_agent", arguments: { op: "get", agent_id: "completed-parent" } });
  expect(get.output).toMatchObject({ worker: { live: false, subtreeLive: true, cleanup: "pending" } });
  let finished = false;
  const stop = tools.execute({ name: "spawn_agent", arguments: { op: "stop", agent_id: "completed-parent" } }).then(result => { finished = true; return result; });
  await vi.waitFor(() => expect(grandchild.signal.aborted).toBe(true));
  expect(finished).toBe(false);
  grandchild.release();
  expect((await stop).output).toMatchObject({ cleanupDrained: true, worker: { subtreeLive: false, cleanup: "drained" } });
  await tree.close();
});

it("counts eleven admitted workers distinctly from four executing slots", async () => {
  vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "4");
  let running = 0;
  const { tools } = executor(async opts => {
    running++;
    await new Promise<void>(resolve => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
    opts.signal.throwIfAborted(); return done();
  });
  await tools.execute({ name: "spawn_agent", arguments: { tasks: Array.from({ length: 11 }, (_, index) => ({ task: `Inspect ${index}` })) } });
  await vi.waitFor(() => expect(running).toBe(4));
  const roster = await tools.execute({ name: "spawn_agent", arguments: { op: "list" } });
  expect(roster.output).toMatchObject({ live: 11, counts: { running: 4, queued: 7 } });
  expect((roster.output as any).workers).toHaveLength(11);
  const drained = await tools.execute({ name: "spawn_agent", arguments: { op: "stop_all" } });
  expect(drained.output).toMatchObject({ live: 0, retainedTerminal: 11, counts: { stopped: 11 } });
  expect(running).toBe(4);
});

it("retains failed worker state without claiming whether writes occurred", async () => {
  const { tools } = executor(async () => { throw new Error("Provider outcome unknown"); }, { consoleSession: false });
  expect((await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect", wait: true } })).success).toBe(false);
  const roster = await tools.execute({ name: "spawn_agent", arguments: { op: "list" } });
  expect(roster.output).toMatchObject({ live: 0, retainedTerminal: 1, counts: { failed: 1 } });
  expect((roster.output as any).workers[0]).toMatchObject({ status: "failed", error: "Provider outcome unknown", cleanup: "drained", effects: "unknown" });
});

it("applies call-wide read_only to all batch entries without false lifting", async () => {
  const { tools } = executor(async () => done(), {
    delegationTools: [TOOL_DEFINITIONS.str_replace, TOOL_DEFINITIONS.spawn_agent, TOOL_DEFINITIONS.done],
  });
  const result = await tools.execute({ name: "spawn_agent", arguments: {
    read_only: true, tasks: [{ task: "A", read_only: false }, { task: "B" }],
  } });
  expect(result.success).toBe(true);
  const listed = await tools.execute({ name: "spawn_agent", arguments: { op: "list" } });
  const workers = (listed.output as { workers: Array<{ workspace: { readOnly: boolean; writeCapable: boolean } }> }).workers;
  expect(workers).toHaveLength(2);
  for (const worker of workers) expect(worker.workspace).toMatchObject({ readOnly: true, writeCapable: false });
});

it("excludes executable binary analysis from read_only catalogs and dispatch when enabled", async () => {
  vi.stubEnv("ZERO_FEATURE_ZEROVERSE", "1");
  const tree = new AuditWorkerTree("parent");
  const lease = tree.acquire("reader", "parent", { workspace: { key: process.cwd(), writeCapable: false, readOnly: true } });
  const { tools } = executor(async () => done(), { scanId: "reader", workerTree: tree,
    delegationTools: [TOOL_DEFINITIONS.analyze_binary, TOOL_DEFINITIONS.done],
  });
  const launcher = vi.spyOn(tools as any, "analyzeBinary").mockResolvedValue({ success: true, output: "must not launch" });
  try {
    expect((tools as any).subagentTools(undefined).map((tool: { name: string }) => tool.name)).not.toContain("analyze_binary");
    const result = await tools.execute({ name: "analyze_binary", arguments: { path: "fixture" } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/read-only/);
    expect(launcher).not.toHaveBeenCalled();
  } finally { lease.release(); await tree.close(); }
});

it("reserves a writable lease for opt-in executable binary analysis", async () => {
  const { tools } = executor(async () => done(), { delegationTools: [TOOL_DEFINITIONS.analyze_binary, TOOL_DEFINITIONS.done] });
  const first = await tools.execute({ name: "spawn_agent", arguments: { task: "Analyze" } });
  expect(first.success).toBe(true);
  const second = await tools.execute({ name: "spawn_agent", arguments: { task: "More analysis" } });
  expect(second.success).toBe(false);
  expect(second.error).toMatch(/Shared checkout is busy/);
});
