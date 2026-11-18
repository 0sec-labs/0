import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeAgentLoopOptions, NativeAgentState } from "./native-loop.js";
import type * as NativeLoopModule from "./native-loop.js";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import type { ToolContext } from "./types.js";

const loop = vi.hoisted(() => ({
  run: undefined as ((options: NativeAgentLoopOptions) => Promise<NativeAgentState>) | undefined,
}));
// Keep real checkpoint helpers while replacing only the long-running worker loop.
vi.mock("./native-loop.js", async (original) => {
  const actual = await original<typeof NativeLoopModule>();
  return {
    ...actual,
    runNativeAgentLoop: (options: NativeAgentLoopOptions) => {
      if (!loop.run) throw new Error("Worker loop not installed");
      return loop.run(options);
    },
  };
});

import { AuditWorkerTree } from "./worker-tree.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
import { createConsoleSession } from "../console/turn-engine.js";
import { eventBus, type SubagentLifecyclePayload } from "../events/bus.js";
import { drainInbox, sendMessage } from "../hub/mailbox.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(scanId: string): ToolContext {
  return { scanId, target: "https://target.test", findings: [], attackResults: [], targetInfo: {},
    delegationTools: [TOOL_DEFINITIONS.load_skill, TOOL_DEFINITIONS.spawn_agent] };
}

function spawnedAgentId(output: unknown): string {
  if (!output || typeof output !== "object" || !("agent_id" in output) || typeof output.agent_id !== "string") {
    throw new Error("Expected a spawned worker identity");
  }
  return output.agent_id;
}

function state(findings: ToolContext["findings"] = []): NativeAgentState {
  return { findings, turnCount: 1, summary: "Finished", done: true } as NativeAgentState;
}

function runtime(script: NativeRuntimeResult[] = []): NativeRuntime {
  return {
    type: "api",
    isAvailable: async () => true,
    forkForSubagent: async () => runtime(),
    executeNative: async () => {
      const next = script.shift();
      if (!next) throw new Error("Unexpected model invocation");
      return next;
    },
  };
}

function endTurn(text: string): NativeRuntimeResult {
  return { content: [{ type: "text", text }], stopReason: "end_turn", durationMs: 0 };
}

afterEach(() => {
  loop.run = undefined;
  eventBus.clear();
  vi.unstubAllEnvs();
});

describe("owned worker stop and drain", () => {
  it("delivers operator mail to workers created under UUID audit identities", async () => {
    const home = mkdtempSync(join(tmpdir(), "0-worker-mailbox-"));
    const executor = new ToolExecutor(
      context("0b61d1cc-613c-4081-97d6-b718b786b012"), null, undefined, async () => runtime(),
    );
    let workerId = "";
    loop.run = async ({ config }) => {
      workerId = config.scanId;
      return state();
    };
    try {
      const spawned = await executor.execute({ name: "spawn_agent", arguments: { task: "inspect" } });
      expect(spawned.success).toBe(true);
      expect(sendMessage(home, {
        id: "operator-note", from: "Main", to: workerId, body: "Inspect the next endpoint", ts: 1,
      }, home).ok).toBe(true);
      expect(drainInbox(home, workerId, home).map((message) => message.body))
        .toEqual(["Inspect the next endpoint"]);
    } finally {
      await executor.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("retains completed ancestry, drains descendants, and leaves other audits alone", async () => {
    const tree = new AuditWorkerTree("audit");
    const other = new AuditWorkerTree("other");
    const parent = tree.acquire("parent", "audit");
    const child = tree.acquire("child", "parent");
    const foreign = other.acquire("child", "other");
    parent.release();
    let drained = false;
    const stop = tree.stop("parent").then((found) => { drained = true; return found; });
    expect(child.signal.aborted).toBe(true);
    expect(foreign.signal.aborted).toBe(false);
    expect(() => tree.acquire("late", "child")).toThrow(/stopping/);
    await Promise.resolve();
    expect(drained).toBe(false);
    child.release();
    expect(await stop).toBe(true);
    expect(await tree.stop("parent")).toBe(false);
    expect(await tree.stop("audit")).toBe(false);
    const next = tree.acquire("next", "audit");
    next.release();
    foreign.release();
    await tree.close();
    await other.close();
  });

  it("keeps admission closed through overlapping drains but permits later conversation work", async () => {
    const tree = new AuditWorkerTree("audit");
    const worker = tree.acquire("worker", "audit");
    const first = tree.stopAll();
    const second = tree.stopAll();
    expect(() => tree.acquire("late", "audit")).toThrow(/stopping/);
    worker.release();
    await Promise.all([first, second]);
    const next = tree.acquire("next", "audit");
    next.release();
    await tree.close();
    expect(() => tree.acquire("after-close", "audit")).toThrow(/closed/);
  });

  it("drains queued work through ordered publication without losing already completed findings", async () => {
    vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
    const running = deferred();
    const cleanup = deferred();
    const ctx = context("audit-queued");
    const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());
    let invocations = 0;
    loop.run = async ({ signal }) => {
      invocations++;
      if (invocations === 1) {
        return state([{ id: "accepted-first" } as ToolContext["findings"][number]]);
      }
      running.resolve();
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup.promise;
      return state([{ id: "late-second" } as ToolContext["findings"][number]]);
    };
    const batch = executor.execute({
      name: "spawn_agent",
      arguments: { tasks: [{ task: "first" }, { task: "second" }, { task: "queued" }] },
    });
    await running.promise;
    let stopped = false;
    const stop = executor.stopPersistentAgents().then(() => { stopped = true; });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      cleanup.resolve();
      await stop;
      expect(ctx.findings.map((finding) => finding.id)).toEqual(["accepted-first"]);
      await batch;
      expect(ctx.findings.map((finding) => finding.id)).toEqual(["accepted-first"]);
      expect(invocations).toBe(2);
    } finally {
      cleanup.resolve();
      await batch;
      await stop;
      await executor.cleanup();
    }
  });

  it("never starts tasks when caller signal is aborted before scheduling, returning valid outcomes and releasing leases", async () => {
    const controller = new AbortController();
    const tree = new AuditWorkerTree("audit-preaborted");
    const ctx = { ...context("audit-preaborted"), workerTree: tree };
    const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

    let loopInvocations = 0;
    loop.run = async () => {
      loopInvocations++;
      return state();
    };

    const lifecycleEvents: SubagentLifecyclePayload[] = [];
    const unsubscribe = eventBus.subscribe({
      emit(type, payload) {
        if (type === "subagent_lifecycle") {
          lifecycleEvents.push(payload as SubagentLifecyclePayload);
          // Abort right when the first task is queued, before mapWithConcurrency scheduling begins
          if (payload.status === "queued" && !controller.signal.aborted) {
            controller.abort();
          }
        }
      },
    });

    try {
      const result = await executor.execute(
        {
          name: "spawn_agent",
          arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }, { task: "task 3" }] },
        },
        { signal: controller.signal },
      );

      expect(loopInvocations).toBe(0);
      expect(result.success).toBe(true);
      const out = result.output as {
        spawned: number;
        succeeded: number;
        failed: number;
        agents: Array<{ index: number; agent_id: string; ok: boolean; error?: string }>;
      };
      expect(out.spawned).toBe(3);
      expect(out.succeeded).toBe(0);
      expect(out.failed).toBe(3);
      expect(out.agents).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(out.agents[i]).toEqual({
          index: i,
          agent_id: expect.any(String),
          ok: false,
          error: "Stopped before dispatch",
        });
      }

      // Check lifecycle events: each task transitioned queued -> stopped
      const queued = lifecycleEvents.filter((e) => e.status === "queued");
      const stopped = lifecycleEvents.filter((e) => e.status === "stopped");
      expect(queued).toHaveLength(3);
      expect(stopped).toHaveLength(3);
      for (const s of stopped) {
        expect(s.summary).toBe("Stopped");
      }

      // All leases released
      expect(tree.hasLiveWorkers()).toBe(false);
      expect(tree.active).toBe(0);
    } finally {
      unsubscribe();
      await executor.cleanup();
      await tree.close();
    }
  });

  it("stops queued tasks from starting when caller signal aborts mid-flight, retaining completed findings and releasing leases", async () => {
    vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
    const controller = new AbortController();
    const tree = new AuditWorkerTree("audit-midabort");
    const ctx = { ...context("audit-midabort"), workerTree: tree };
    const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

    let loopInvocations = 0;
    const task2Started = deferred();
    const task2Finish = deferred();

    loop.run = async () => {
      loopInvocations++;
      if (loopInvocations === 1) {
        // Task 1 runs and completes normally before cancellation
        return state([{ id: "finding-completed-child" } as ToolContext["findings"][number]]);
      }
      if (loopInvocations === 2) {
        // Task 2 runs; signal aborts during its execution
        task2Started.resolve();
        await task2Finish.promise;
        return state();
      }
      return state();
    };

    const lifecycleEvents: SubagentLifecyclePayload[] = [];
    const unsubscribe = eventBus.subscribe({
      emit(type, payload) {
        if (type === "subagent_lifecycle") lifecycleEvents.push(payload as SubagentLifecyclePayload);
      },
    });

    const execution = executor.execute(
      {
        name: "spawn_agent",
        arguments: { tasks: [{ task: "first" }, { task: "second" }, { task: "third" }] },
      },
      { signal: controller.signal },
    );

    // Wait until task 2 is in-flight, then abort the caller signal
    await task2Started.promise;
    controller.abort();
    // Allow task 2 to finish
    task2Finish.resolve();

    try {
      const result = await execution;

      // Tasks 1 and 2 ran; queued task 3 was never dispatched
      expect(loopInvocations).toBe(2);
      expect(result.success).toBe(true);

      const out = result.output as {
        spawned: number;
        succeeded: number;
        failed: number;
        agents: Array<{ index: number; agent_id: string; ok: boolean; findings?: number; error?: string }>;
      };
      expect(out.spawned).toBe(3);
      expect(out.succeeded).toBe(1);
      expect(out.failed).toBe(2);
      expect(out.agents).toHaveLength(3);

      // Task 1 completed successfully
      expect(out.agents[0].ok).toBe(true);
      expect(out.agents[0].findings).toBe(1);

      // Task 2 failed/stopped due to abort
      expect(out.agents[1].ok).toBe(false);

      // Task 3 was never dispatched and has explicit stopped outcome
      expect(out.agents[2]).toEqual({
        index: 2,
        agent_id: expect.any(String),
        ok: false,
        error: "Stopped before dispatch",
      });

      // Findings from completed task 1 are retained in context
      expect(ctx.findings.map((f) => f.id)).toEqual(["finding-completed-child"]);

      // Task 3 received terminal lifecycle event "stopped"
      const stoppedTasks = lifecycleEvents.filter((e) => e.status === "stopped").map((e) => e.task);
      expect(stoppedTasks).toContain("third");

      // All leases released
      expect(tree.hasLiveWorkers()).toBe(false);
      expect(tree.active).toBe(0);
    } finally {
      unsubscribe();
      await executor.cleanup();
      await tree.close();
    }
  });

  it("releases leases for undispatched and completed tasks exactly once", async () => {
    vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
    const controller = new AbortController();
    const tree = new AuditWorkerTree("audit-leases");
    const ctx = { ...context("audit-leases"), workerTree: tree };

    const leaseReleases = new Map<string, number>();
    const originalAcquire = tree.acquire.bind(tree);
    tree.acquire = (id: string, parentId: string) => {
      const lease = originalAcquire(id, parentId);
      leaseReleases.set(id, 0);
      const originalRelease = lease.release;
      lease.release = () => {
        leaseReleases.set(id, (leaseReleases.get(id) ?? 0) + 1);
        originalRelease();
      };
      return lease;
    };

    const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());
    const task1Started = deferred();
    const task1Finish = deferred();

    loop.run = async () => {
      task1Started.resolve();
      await task1Finish.promise;
      return state();
    };

    const execution = executor.execute(
      {
        name: "spawn_agent",
        arguments: { tasks: [{ task: "t1" }, { task: "t2" }, { task: "t3" }] },
      },
      { signal: controller.signal },
    );

    await task1Started.promise;
    controller.abort();
    task1Finish.resolve();

    try {
      await execution;
      expect(leaseReleases.size).toBe(3);
      for (const [, count] of leaseReleases) {
        expect(count).toBe(1);
      }
      expect(tree.hasLiveWorkers()).toBe(false);
      expect(tree.active).toBe(0);
    } finally {
      await executor.cleanup();
      await tree.close();
    }
  });
  it("drains cancellation during concurrent runtime initialization without starting queued work", async () => {
    vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
    const controller = new AbortController();
    const tree = new AuditWorkerTree("audit-initializing-cancel");
    const ctx = { ...context("audit-initializing-cancel"), workerTree: tree };
    const firstStarted = deferred<AbortSignal>();
    const firstCleanup = deferred();
    const secondInitializing = deferred();
    const secondReady = deferred();
    const isAvailable = vi.fn(async () => true);
    const releases: number[] = [];
    const acquire = tree.acquire.bind(tree);
    tree.acquire = (id, parentId) => {
      const lease = acquire(id, parentId);
      const index = releases.push(0) - 1;
      const release = lease.release;
      lease.release = () => { releases[index]++; release(); };
      return lease;
    };
    let forks = 0;
    const factory = vi.fn(async () => {
      if (++forks === 2) { secondInitializing.resolve(); await secondReady.promise; }
      return { ...runtime(), isAvailable };
    });
    const executor = new ToolExecutor(ctx, null, undefined, factory);
    let loops = 0;
    loop.run = async ({ signal }) => {
      loops++;
      firstStarted.resolve(signal!);
      await firstCleanup.promise;
      return state([{ id: "late-after-cancel" } as ToolContext["findings"][number]]);
    };
    const events: SubagentLifecyclePayload[] = [];
    const unsubscribe = eventBus.subscribe({ emit(type, payload) {
      if (type === "subagent_lifecycle") events.push(payload as SubagentLifecyclePayload);
    } });
    const batch = executor.execute({ name: "spawn_agent", arguments: {
      tasks: [{ task: "running" }, { task: "initializing" }, { task: "queued" }],
    } }, { signal: controller.signal });
    let stop: Promise<void> | undefined;
    try {
      const [signal] = await Promise.all([firstStarted.promise, secondInitializing.promise]);
      controller.abort();
      expect(signal.aborted).toBe(true);
      let drained = false;
      stop = executor.stopPersistentAgents().then(() => { drained = true; });
      secondReady.resolve();
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(tree.hasLiveWorkers()).toBe(true);
      firstCleanup.resolve();
      const result = await batch;
      await stop;
      expect(result.success).toBe(true);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(isAvailable).toHaveBeenCalledOnce();
      expect(loops).toBe(1);
      expect(ctx.findings).toEqual([]);
      expect(result.output).toMatchObject({ spawned: 3, succeeded: 0, failed: 3,
        agents: [expect.objectContaining({ ok: false }), expect.objectContaining({ ok: false }),
          expect.objectContaining({ ok: false, error: "Stopped before dispatch" })] });
      const stopped = events.filter(event => event.status === "stopped");
      expect(stopped).toHaveLength(3);
      expect(new Set(stopped.map(event => event.agent_id)).size).toBe(3);
      expect(events.filter(event => event.status === "running")).toHaveLength(1);
      expect(releases).toEqual([1, 1, 1]);
      expect(tree.hasLiveWorkers()).toBe(false);
    } finally {
      firstCleanup.resolve(); secondReady.resolve();
      await batch; await stop; unsubscribe(); await executor.cleanup(); await tree.close();
    }
  });

  describe("batch subagent individual stop and execution lease lifecycle", () => {
    it("1. targeted stop returns while an unrelated sibling remains active", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
      const tree = new AuditWorkerTree("audit-target-stop");
      const ctx = { ...context("audit-target-stop"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      const t1Started = deferred<string>();
      const t2Started = deferred<void>();
      const t2Finish = deferred<void>();

      loop.run = async ({ config, signal }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Started.resolve(config.scanId);
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          return state();
        } else {
          t2Started.resolve();
          await t2Finish.promise;
          return state();
        }
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }] },
      });

      const t1Id = await t1Started.promise;
      await t2Started.promise;

      // Stop ONLY task 1
      let t1StopResolved = false;
      const stopPromise = executor.stopPersistentAgent(t1Id).then((r) => {
        t1StopResolved = true;
        return r;
      });

      // Verify task 1 stop resolves promptly while task 2 is STILL running
      const stopped = await stopPromise;
      expect(stopped).toBe(true);
      expect(t1StopResolved).toBe(true);

      // Unblock task 2 and settle batch
      t2Finish.resolve();
      const result = await batch;

      expect(result.success).toBe(true);
      const out = result.output as any;
      expect(out.agents[0].ok).toBe(false);
      expect(out.agents[1].ok).toBe(true);
      await executor.cleanup();
      await tree.close();
    });

    it("2. a naturally completed worker releases its capacity before the batch finishes", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
      const tree = new AuditWorkerTree("audit-capacity-release");
      const ctx = { ...context("audit-capacity-release"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      const t1Done = deferred<void>();
      const t1Released = deferred<void>();
      const t2Started = deferred<void>();
      const t2Finish = deferred<void>();

      const origAcquire = tree.acquire.bind(tree);
      tree.acquire = (id, parentId, meta) => {
        const lease = origAcquire(id, parentId, meta);
        const origRel = lease.release;
        lease.release = () => {
          origRel();
          if (meta?.task === "task 1") t1Released.resolve();
        };
        return lease;
      };

      loop.run = async ({ config }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Done.resolve();
          return state();
        } else {
          t2Started.resolve();
          await t2Finish.promise;
          return state();
        }
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }] },
      });

      await t1Done.promise;
      await t2Started.promise;
      await t1Released.promise;

      // While task 2 is still running, task 1 must have released its capacity
      expect(tree.active).toBe(1);

      t2Finish.resolve();
      await batch;
      expect(tree.active).toBe(0);
      expect(tree.hasLiveWorkers()).toBe(false);
      await executor.cleanup();
      await tree.close();
    });

    it("3. completed workers no longer appear in peers() or snapshot() as live", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
      const tree = new AuditWorkerTree("audit-peers-cleanup");
      const ctx = { ...context("audit-peers-cleanup"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      let task1Id = "";
      const t1Done = deferred<void>();
      const t1Released = deferred<void>();
      const t2Started = deferred<void>();
      const t2Finish = deferred<void>();

      const origAcquire = tree.acquire.bind(tree);
      tree.acquire = (id, parentId, meta) => {
        const lease = origAcquire(id, parentId, meta);
        const origRel = lease.release;
        lease.release = () => {
          origRel();
          if (meta?.task === "task 1") t1Released.resolve();
        };
        return lease;
      };

      loop.run = async ({ config }) => {
        if (config.systemPrompt?.includes("task 1")) {
          task1Id = config.scanId;
          t1Done.resolve();
          return state();
        } else {
          t2Started.resolve();
          await t2Finish.promise;
          return state();
        }
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }] },
      });

      await t1Done.promise;
      await t2Started.promise;
      await t1Released.promise;

      // Task 1 must not be in peers while task 2 is still running
      const peers = tree.peers("audit-peers-cleanup");
      expect(peers).not.toContain(task1Id);

      // Snapshot must show task 1 as drained and not live
      const snapshot = tree.snapshot("audit-peers-cleanup");
      const t1Snap = snapshot.workers.find((w) => w.id === task1Id);
      expect(t1Snap).toBeDefined();
      expect(t1Snap?.live).toBe(false);
      expect(t1Snap?.cleanup).toBe("drained");

      t2Finish.resolve();
      await batch;
      await executor.cleanup();
      await tree.close();
    });

    it("5. queued tasks behave correctly after an individual stop", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
      const tree = new AuditWorkerTree("audit-queued-stop");
      const ctx = { ...context("audit-queued-stop"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      const t1Started = deferred<string>();

      loop.run = async ({ config, signal }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Started.resolve(config.scanId);
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          return state();
        }
        return state();
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }, { task: "task 3" }] },
      });

      const t1Id = await t1Started.promise;
      const stopped = await executor.stopPersistentAgent(t1Id);
      expect(stopped).toBe(true);

      const result = await batch;
      expect(result.success).toBe(true);
      const out = result.output as any;
      expect(out.spawned).toBe(3);
      expect(out.succeeded).toBe(2);
      expect(out.failed).toBe(1);
      expect(out.agents[0].ok).toBe(false);
      expect(out.agents[1].ok).toBe(true);
      expect(out.agents[2].ok).toBe(true);
      await executor.cleanup();
      await tree.close();
    });

    it("6. stopAll() retains its existing cancellation and publication guarantees", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
      const tree = new AuditWorkerTree("audit-stopall-guarantees");
      const ctx = { ...context("audit-stopall-guarantees"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      const t1Started = deferred<void>();
      const t2Started = deferred<void>();

      loop.run = async ({ config, signal }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Started.resolve();
        } else if (config.systemPrompt?.includes("task 2")) {
          t2Started.resolve();
        }
        await new Promise((resolve) => signal?.addEventListener("abort", resolve));
        return state();
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }, { task: "task 3" }] },
      });

      await Promise.all([t1Started.promise, t2Started.promise]);
      await executor.stopPersistentAgents();

      const result = await batch;
      expect(result.success).toBe(true);
      expect(tree.hasLiveWorkers()).toBe(false);
      expect(tree.active).toBe(0);
      const out = result.output as any;
      expect(out.succeeded).toBe(0);
      expect(out.failed).toBe(3);
      await executor.cleanup();
      await tree.close();
    });

    it("7. no findings are merged after the relevant stop operation resolves", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
      const tree = new AuditWorkerTree("audit-no-findings-after-stop");
      const ctx = { ...context("audit-no-findings-after-stop"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      const t1Started = deferred<string>();
      const t2Started = deferred<void>();
      const t2Finish = deferred<void>();

      loop.run = async ({ config, signal }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Started.resolve(config.scanId);
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          return state([{ id: "stale-finding-1" } as any]);
        } else {
          t2Started.resolve();
          await t2Finish.promise;
          return state();
        }
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }] },
      });

      const t1Id = await t1Started.promise;
      await t2Started.promise;

      await executor.stopPersistentAgent(t1Id);

      // Stop has resolved: ctx.findings must not have received task 1's findings
      expect(ctx.findings.map((f) => f.id)).not.toContain("stale-finding-1");

      t2Finish.resolve();
      await batch;
      expect(ctx.findings.map((f) => f.id)).not.toContain("stale-finding-1");
      await executor.cleanup();
      await tree.close();
    });

    it("8. nested delegation can use capacity released by a completed worker", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
      // Limit tree to exactly 2 workers
      const tree = new AuditWorkerTree("audit-nested-capacity", 2);
      const ctx = { ...context("audit-nested-capacity"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      let nestedSuccess = false;

      loop.run = async ({ config }) => {
        if (config.systemPrompt?.includes("task 1")) {
          return state();
        } else if (config.systemPrompt?.includes("task 2")) {
          // Task 1 has completed. Task 2 delegates a helper.
          // If task 1 held its lease, this would throw "Audit worker capacity reached (2)".
          const helperLease = tree.acquire("nested-helper", config.scanId);
          nestedSuccess = true;
          helperLease.release();
          return state();
        }
        return state();
      };

      const result = await executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }] },
      });

      expect(result.success).toBe(true);
      expect(nestedSuccess).toBe(true);
      expect(tree.hasLiveWorkers()).toBe(false);
      await executor.cleanup();
      await tree.close();
    });

    it("9. multiple concurrent stop requests remain safe", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
      const tree = new AuditWorkerTree("audit-concurrent-stops");
      const ctx = { ...context("audit-concurrent-stops"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      const t1Started = deferred<string>();
      const t2Finish = deferred<void>();

      loop.run = async ({ config, signal }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Started.resolve(config.scanId);
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          return state();
        } else {
          await t2Finish.promise;
          return state();
        }
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }] },
      });

      const t1Id = await t1Started.promise;

      // Dispatch 3 concurrent stop requests for the same worker
      const [s1, s2, s3] = await Promise.all([
        executor.stopPersistentAgent(t1Id),
        executor.stopPersistentAgent(t1Id),
        tree.stop(t1Id),
      ]);

      expect(s1).toBe(true);
      expect(typeof s2).toBe("boolean");
      expect(typeof s3).toBe("boolean");

      t2Finish.resolve();
      await batch;
      await executor.cleanup();
      await tree.close();
    });

    it("10. lease release remains idempotent across normal completion, cancellation, and outer batch cleanup", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
      const tree = new AuditWorkerTree("audit-idempotent-leases");
      const ctx = { ...context("audit-idempotent-leases"), workerTree: tree };

      const leaseReleases = new Map<string, number>();
      const originalAcquire = tree.acquire.bind(tree);
      tree.acquire = (id: string, parentId: string, metadata?: any) => {
        const lease = originalAcquire(id, parentId, metadata);
        leaseReleases.set(id, 0);
        const originalRelease = lease.release;
        lease.release = () => {
          leaseReleases.set(id, (leaseReleases.get(id) ?? 0) + 1);
          originalRelease();
        };
        return lease;
      };

      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());
      const t1Started = deferred<string>();
      const t2Started = deferred<string>();

      loop.run = async ({ config, signal }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Started.resolve(config.scanId);
          return state();
        } else if (config.systemPrompt?.includes("task 2")) {
          t2Started.resolve(config.scanId);
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          return state();
        }
        return state();
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }, { task: "task 3" }] },
      });

      await t1Started.promise;
      const t2Id = await t2Started.promise;

      // Stop task 2 while task 3 is queued
      await executor.stopPersistentAgent(t2Id);

      await batch;

      // All 3 tasks must have their underlying lease released exactly once
      expect(leaseReleases.size).toBe(3);
      for (const [, count] of leaseReleases) {
        expect(count).toBe(1);
      }
      expect(tree.hasLiveWorkers()).toBe(false);
      expect(tree.active).toBe(0);
      await executor.cleanup();
      await tree.close();
    });

    it("11. targeted stop of an already-completed worker prevents late publication while sibling continues", async () => {
      vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "2");
      const tree = new AuditWorkerTree("audit-stop-after-execution");
      const ctx = { ...context("audit-stop-after-execution"), workerTree: tree };
      const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());

      const t1Started = deferred<string>();
      const t1Finished = deferred<void>();
      const t1Released = deferred<void>();
      const t2Started = deferred<string>();
      const t2Finish = deferred<void>();

      const origAcquire = tree.acquire.bind(tree);
      tree.acquire = (id, parentId, meta) => {
        const lease = origAcquire(id, parentId, meta);
        const origRel = lease.release;
        lease.release = () => {
          origRel();
          if (meta?.task === "task 1") t1Released.resolve();
        };
        return lease;
      };

      loop.run = async ({ config }) => {
        if (config.systemPrompt?.includes("task 1")) {
          t1Started.resolve(config.scanId);
          const st = state([{ id: "finding-from-task-1" } as any]);
          t1Finished.resolve();
          return st;
        } else {
          t2Started.resolve(config.scanId);
          await t2Finish.promise;
          return state([{ id: "finding-from-task-2" } as any]);
        }
      };

      const batch = executor.execute({
        name: "spawn_agent",
        arguments: { tasks: [{ task: "task 1" }, { task: "task 2" }] },
      });

      const t1Id = await t1Started.promise;
      const t2Id = await t2Started.promise;
      await t1Finished.promise;
      await t1Released.promise;

      // Task 1 execution has finished, capacity is freed (tree.active is 1 because only task 2 is running)
      expect(tree.active).toBe(1);

      // Request targeted stop of Task 1 while Task 2 is STILL RUNNING
      let stopResolved = false;
      const stopPromise = executor.stopPersistentAgent(t1Id).then((r) => {
        stopResolved = true;
        return r;
      });

      const stopped = await stopPromise;
      expect(stopped).toBe(true);
      expect(stopResolved).toBe(true);

      // Verify that publication of task 1 is already cancelled
      expect(tree.isPublicationCancelled(t1Id)).toBe(true);

      // Now unblock task 2 and settle batch
      t2Finish.resolve();
      const result = await batch;

      expect(result.success).toBe(true);
      const out = result.output as any;
      expect(out.succeeded).toBe(1);
      expect(out.failed).toBe(1);
      expect(out.agents[0]).toMatchObject({
        agent_id: t1Id,
        ok: false,
        error: "Worker stopped by operator",
      });
      expect(out.agents[1]).toMatchObject({
        agent_id: t2Id,
        ok: true,
      });

      // Crucial: Task 1's findings MUST NOT be in ctx.findings, but Task 2's findings MUST be
      expect(ctx.findings.map((f) => f.id)).not.toContain("finding-from-task-1");
      expect(ctx.findings.map((f) => f.id)).toContain("finding-from-task-2");

      // Stopping task 1 again after publication has fully settled returns false
      const stoppedAgain = await executor.stopPersistentAgent(t1Id);
      expect(stoppedAgain).toBe(false);

      expect(tree.hasLiveWorkers()).toBe(false);
      await executor.cleanup();
      await tree.close();
    });
  });

});
