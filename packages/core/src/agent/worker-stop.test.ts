import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeAgentLoopOptions, NativeAgentState } from "./native-loop.js";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import type { ToolContext } from "./types.js";

const loop = vi.hoisted(() => ({
  run: undefined as ((options: NativeAgentLoopOptions) => Promise<NativeAgentState>) | undefined,
}));
vi.mock("./native-loop.js", () => ({
  runNativeAgentLoop: (options: NativeAgentLoopOptions) => {
    if (!loop.run) throw new Error("Worker loop not installed");
    return loop.run(options);
  },
}));

import { AuditWorkerTree } from "./worker-tree.js";
import { ToolExecutor } from "./tools.js";
import { createConsoleSession } from "../console/turn-engine.js";
import { eventBus } from "../events/bus.js";
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
    const home = mkdtempSync(join(tmpdir(), "0sec-worker-mailbox-"));
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
});
