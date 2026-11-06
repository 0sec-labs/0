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
import { ToolExecutor } from "./tools.js";
import { createConsoleSession } from "../console/turn-engine.js";
import { eventBus, type SubagentLifecyclePayload } from "../events/bus.js";
import { drainInbox, sendMessage } from "../hub/mailbox.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(scanId: string): ToolContext {
  return { scanId, target: "https://target.test", findings: [], attackResults: [], targetInfo: {} };
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

  it("waits for real child-loop cleanup and rejects findings returned after cancellation", async () => {
    const started = deferred<AbortSignal>();
    const cleanup = deferred();
    const ctx = context("audit-stop");
    const executor = new ToolExecutor(ctx, null, undefined, async () => runtime());
    loop.run = async ({ signal }) => {
      started.resolve(signal!);
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup.promise;
      return state([{ id: "late-finding" } as ToolContext["findings"][number]]);
    };
    const spawned = await executor.execute({ name: "spawn_persistent_agent", arguments: { task: "wait for stop" } });
    const id = spawnedAgentId(spawned.output);
    const signal = await started.promise;
    let stopped = false;
    const stop = executor.stopPersistentAgent(id).then((found) => { stopped = true; return found; });
    try {
      expect(signal.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
      cleanup.resolve();
      expect(await stop).toBe(true);
      expect(ctx.findings).toEqual([]);
      expect(await executor.stopPersistentAgent("foreign-worker")).toBe(false);
    } finally {
      cleanup.resolve();
      await stop;
      await executor.cleanup();
    }
  });

  it("does not dispose a detached descendant when its spawning invocation completes", async () => {
    const grandchildStarted = deferred<AbortSignal>();
    const parentFinished = deferred();
    const executor = new ToolExecutor(context("audit-descendants"), null, undefined, async () => runtime());
    loop.run = async (options) => {
      if (options.config.systemPrompt.includes("outer task")) {
        const borrowed = new ToolExecutor({
          ...context(options.config.scanId),
          workerTree: options.config.workerTree,
          workerFindings: options.config.workerFindings,
        }, null, undefined, async () => runtime());
        await borrowed.execute({ name: "spawn_persistent_agent", arguments: { task: "inner task" } });
        await grandchildStarted.promise;
        await borrowed.cleanup();
        parentFinished.resolve();
        return state();
      }
      grandchildStarted.resolve(options.signal!);
      await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return state();
    };
    const spawned = await executor.execute({ name: "spawn_persistent_agent", arguments: { task: "outer task" } });
    try {
      await parentFinished.promise;
      const signal = await grandchildStarted.promise;
      expect(signal.aborted).toBe(false);
      await executor.stopPersistentAgent(spawnedAgentId(spawned.output));
      expect(signal.aborted).toBe(true);
    } finally {
      await executor.cleanup();
    }
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
      name: "spawn_agents",
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

  it("stops workers through ConsoleSession without clearing or disabling the conversation", async () => {
    const started = deferred();
    loop.run = async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return state();
    };
    const session = createConsoleSession({
      runtime: runtime([
        { content: [{ type: "tool_use", id: "spawn", name: "spawn_persistent_agent", input: { task: "stay available" } }], stopReason: "tool_use", durationMs: 0 },
        endTurn("Worker started."),
        endTurn("The conversation continues."),
      ]),
      allowModelSelfExtension: false,
    });
    try {
      await session.send("Start a worker.");
      await started.promise;
      const history = structuredClone(session.messages);
      await session.stopPersistentAgents();
      expect(session.messages).toEqual(history);
      expect((await session.send("Continue here.")).assistantText).toBe("The conversation continues.");
    } finally {
      await session.cleanup();
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
          name: "spawn_agents",
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
        name: "spawn_agents",
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
        name: "spawn_agents",
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
});
