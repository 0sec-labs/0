import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared controller for the mocked native loop. `vi.hoisted` runs before the
// `vi.mock` factory below, so the factory can close over it. Each test installs
// an `impl` that stands in for one subagent's `runNativeAgentLoop` call.
const h = vi.hoisted(() => ({
  impl: null as null | ((opts: any) => Promise<any>),
  inFlight: 0,
  peak: 0,
  configs: [] as any[],
}));

vi.mock("./native-loop.js", () => ({
  runNativeAgentLoop: async (opts: any) => {
    h.configs.push(opts.config);
    if (!h.impl) throw new Error("test did not install a native-loop impl");
    return h.impl(opts);
  },
}));

import { eventBus } from "../events/bus.js";
import type { SubagentLifecyclePayload } from "../events/bus.js";
import { ToolExecutor } from "./tools.js";
import type { ToolContext } from "./types.js";
import type { NativeRuntime } from "../runtime/types.js";
import { ScanCostLedger } from "./cost-ledger.js";

/** Minimal NativeRuntime sentinel for child test fixtures — never touches fs/net. */
async function fakeRuntime(_timeoutMs?: number): Promise<NativeRuntime> {
  return {
    type: "api",
    isAvailable: async () => true,
    executeNative: async () => ({ content: [], stopReason: "end_turn" as const, durationMs: 0 }),
  };
}

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    target: "https://target.test",
    scanId: "parent-scan",
    findings: [],
    attackResults: [],
    targetInfo: {},
    ...overrides,
  };
}

/** Minimal fake NativeAgentState — the handler only reads these fields. */
function fakeState(findings: unknown[], done = true) {
  return { findings, turnCount: 1, summary: "did the thing", done } as any;
}

function collectLifecycle(): {
  events: SubagentLifecyclePayload[];
  unsubscribe: () => void;
} {
  const events: SubagentLifecyclePayload[] = [];
  const unsubscribe = eventBus.subscribe({
    emit: (type, payload) => {
      if (type === "subagent_lifecycle") {
        events.push(payload as SubagentLifecyclePayload);
      }
    },
  });
  return { events, unsubscribe };
}

describe("spawn_agents — concurrent subagent dispatch", () => {
  beforeEach(() => {
    eventBus.clear();
    h.impl = null;
    h.inFlight = 0;
    h.peak = 0;
    h.configs = [];
  });

  afterEach(() => {
    eventBus.clear();
    delete process.env["ZERO_SUBAGENT_CONCURRENCY"];
  });

  it("inherits absolute repo B identity in a batch and rejects repo A substitution before analysis", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-worker-target-"));
    const createRepo = (name: string) => {
      const dir = join(root, name); mkdirSync(dir);
      const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
      git(["init", "-q"]);
      git(["remote", "add", "origin", `https://example.test/${name}.git`]);
      writeFileSync(join(dir, `${name}.txt`), name);
      git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", name]);
      return dir;
    };
    try {
      const a = createRepo("a"); const b = createRepo("b");
      vi.stubEnv("GIT_DIR", join(a, ".git"));
      vi.stubEnv("GIT_WORK_TREE", a);
      h.impl = async () => fakeState([]);
      const ctx = toolContext({ role: "audit", scopePath: b, workspaceRoot: a });
      const executor = new ToolExecutor(ctx, undefined, undefined, fakeRuntime);
      const result = await executor.execute({ name: "spawn_agents", arguments: { tasks: [{ task: "alpha" }, { task: "beta" }] } });
      expect(result.output).toMatchObject({ succeeded: 2, failed: 0 });
      expect(h.configs).toHaveLength(2);
      for (const config of h.configs) {
        expect(config.scopePath).toBe(realpathSync(b));
        expect(config.workspaceRoot).toBe(a);
        expect(config.workspaceIdentity).toMatchObject({ scopePath: realpathSync(b), origin: "https://example.test/b.git" });
      }
      expect(h.configs[0].workspaceIdentity).toBe(h.configs[1].workspaceIdentity);

      h.configs = [];
      const remapped = new ToolExecutor(ctx, undefined, undefined, async () => {
        ctx.scopePath = a;
        return fakeRuntime();
      });
      const rejected = await remapped.execute({ name: "spawn_agents", arguments: { tasks: [{ task: "alpha" }, { task: "beta" }] } });
      expect(rejected.output).toMatchObject({ succeeded: 0, failed: 2 });
      expect(JSON.stringify(rejected.output)).toContain("workspace_mismatch");
      expect(h.configs).toHaveLength(0);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  it("(1) runs two children to completion, merges findings, distinct agent_ids", async () => {
    const { events, unsubscribe } = collectLifecycle();
    // One finding per child, tagged with the task so we can assert the merge.
    h.impl = async (opts) => {
      const task = opts.config.systemPrompt as string;
      const tag = task.includes("alpha") ? "A" : "B";
      return fakeState([{ id: `finding-${tag}` }]);
    };

    try {
      const ctx = toolContext();
      const executor = new ToolExecutor(ctx, undefined, undefined, fakeRuntime);
      const result = await executor.execute({
        name: "spawn_agents",
        arguments: {
          tasks: [{ task: "probe alpha" }, { task: "probe beta" }],
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ spawned: 2, succeeded: 2, failed: 0 });
      // Findings merged into the PARENT context, in index order.
      expect(ctx.findings.map((f: any) => f.id)).toEqual(["finding-A", "finding-B"]);

      const queued = events.filter((e) => e.status === "queued");
      const ids = new Set(queued.map((e) => e.agent_id));
      expect(ids.size).toBe(2);
      for (const id of ids) expect(id).toMatch(/^parent-scan-sub-/);
    } finally {
      unsubscribe();
    }
  });

  it("delivers shared batch instructions to both children without mixing their tasks", async () => {
    const prompts: string[] = [];
    const shared = "# Constraints\nBATCH_CONTEXT_SENTINEL: keep the target unchanged.";
    const tasks = ["PRIVATE_TASK_ALPHA", "PRIVATE_TASK_BETA"];
    h.impl = async (opts) => {
      prompts.push(opts.config.systemPrompt);
      return fakeState([]);
    };
    const executor = new ToolExecutor(toolContext(), undefined, undefined, fakeRuntime);
    const result = await executor.execute({
      name: "spawn_agents",
      arguments: { context: shared, tasks: tasks.map((task) => ({ task })) },
    });

    expect(result.output).toMatchObject({ spawned: 2, succeeded: 2, failed: 0 });
    expect(prompts).toHaveLength(2);
    for (const task of tasks) {
      const prompt = prompts.find((value) => value.includes(task));
      expect(prompt).toContain(shared);
      expect(prompt).not.toContain(tasks.find((value) => value !== task));
    }
  });

  it("(2) isolates failure: one child throws, the other still returns its finding", async () => {
    h.impl = async (opts) => {
      if ((opts.config.systemPrompt as string).includes("BOOM")) {
        throw new Error("child exploded");
      }
      return fakeState([{ id: "good-finding" }]);
    };

    const ctx = toolContext();
    const executor = new ToolExecutor(ctx, undefined, undefined, fakeRuntime);
    const result = await executor.execute({
      name: "spawn_agents",
      arguments: {
        tasks: [{ task: "do BOOM" }, { task: "do fine" }],
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ spawned: 2, succeeded: 1, failed: 1 });
    // Only the surviving child's finding lands in the parent.
    expect(ctx.findings.map((f: any) => f.id)).toEqual(["good-finding"]);

    const agents = (result.output as any).agents as any[];
    expect(agents[0]).toMatchObject({ index: 0, ok: false });
    expect(agents[0].error).toContain("child exploded");
    expect(agents[1]).toMatchObject({ index: 1, ok: true, findings: 1 });
  });

  it("(3) shared cost ceiling caps the whole batch across concurrent children", async () => {
    // Pre-load the shared ledger ABOVE the ceiling, standing in for spend by
    // other sessions in the same scan. Because every child shares this one
    // ledger + ceiling, none should be allowed to produce findings.
    const ledger = new ScanCostLedger();
    ledger.add({ inputTokens: 50_000_000, outputTokens: 50_000_000 });
    const ceiling = 0.01;
    expect(ledger.totalCostUsd()).toBeGreaterThan(ceiling);

    const seenLedgers: unknown[] = [];
    h.impl = async (opts) => {
      seenLedgers.push(opts.config.costLedger);
      const running = opts.config.costLedger
        ? opts.config.costLedger.totalCostUsd()
        : 0;
      if (
        opts.config.costCeilingUsd !== undefined &&
        running >= opts.config.costCeilingUsd
      ) {
        // Ceiling already tripped — return a partial (no new findings), which
        // is exactly what the real native loop does on costCeilingExceeded.
        return fakeState([], false);
      }
      opts.config.costLedger?.add({ inputTokens: 1_000, outputTokens: 1_000 });
      return fakeState([{ id: "should-not-happen" }]);
    };

    const ctx = toolContext({
      costLedger: ledger,
      costCeilingUsd: ceiling,
      costModel: "claude-sonnet-4",
    });
    const executor = new ToolExecutor(ctx, undefined, undefined, fakeRuntime);
    const result = await executor.execute({
      name: "spawn_agents",
      arguments: {
        tasks: [
          { task: "child 1" },
          { task: "child 2" },
          { task: "child 3" },
          { task: "child 4" },
        ],
      },
    });

    expect(result.success).toBe(true);
    // Batch capped: no findings produced despite four children.
    expect(ctx.findings).toHaveLength(0);
    // Every child received the SAME shared ledger instance.
    expect(seenLedgers).toHaveLength(4);
    for (const l of seenLedgers) expect(l).toBe(ledger);
  });

  it("(4) concurrency cap bounds the peak number of in-flight children", async () => {
    // 6 children, default cap of 4. Instrument entry/exit to record the peak.
    h.impl = async () => {
      h.inFlight += 1;
      h.peak = Math.max(h.peak, h.inFlight);
      await new Promise((r) => setTimeout(r, 10));
      h.inFlight -= 1;
      return fakeState([]);
    };

    const ctx = toolContext();
    const executor = new ToolExecutor(ctx, undefined, undefined, fakeRuntime);
    const result = await executor.execute({
      name: "spawn_agents",
      arguments: {
        tasks: Array.from({ length: 6 }, (_, i) => ({ task: `child ${i}` })),
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ spawned: 6, succeeded: 6, failed: 0 });
    // Peak never exceeds SUBAGENT_CONCURRENCY (default 4)...
    expect(h.peak).toBeLessThanOrEqual(4);
    // ...and children genuinely overlapped (not serialized).
    expect(h.peak).toBeGreaterThan(1);
  });

  it("(5) emits queued -> running -> terminal exactly once per child, no cross-bleed", async () => {
    const { events, unsubscribe } = collectLifecycle();
    h.impl = async () => fakeState([]);

    try {
      const ctx = toolContext();
      const executor = new ToolExecutor(ctx, undefined, undefined, fakeRuntime);
      await executor.execute({
        name: "spawn_agents",
        arguments: { tasks: [{ task: "a" }, { task: "b" }] },
      });

      // Group events by child.
      const byAgent = new Map<string, string[]>();
      for (const e of events) {
        const seq = byAgent.get(e.agent_id) ?? [];
        seq.push(e.status);
        byAgent.set(e.agent_id, seq);
      }

      expect(byAgent.size).toBe(2);
      for (const seq of byAgent.values()) {
        expect(seq).toEqual(["queued", "running", "completed"]);
      }
    } finally {
      unsubscribe();
    }
  });



  it("(8) rejects empty, oversized, and malformed task lists with a structured error", async () => {
    const executor = new ToolExecutor(toolContext(), undefined, undefined, fakeRuntime);

    const empty = await executor.execute({
      name: "spawn_agents",
      arguments: { tasks: [] },
    });
    expect(empty).toMatchObject({ success: false });
    expect(empty.error).toContain("non-empty array");

    const notArray = await executor.execute({
      name: "spawn_agents",
      arguments: { tasks: "nope" },
    });
    expect(notArray).toMatchObject({ success: false });

    const oversized = await executor.execute({
      name: "spawn_agents",
      arguments: {
        tasks: Array.from({ length: 9 }, (_, i) => ({ task: `child ${i}` })),
      },
    });
    expect(oversized).toMatchObject({ success: false });
    expect(oversized.error).toContain("max 8");

    const malformed = await executor.execute({
      name: "spawn_agents",
      arguments: { tasks: [{ task: "ok" }, { max_turns: 3 }] },
    });
    expect(malformed).toMatchObject({ success: false });
    expect(malformed.error).toContain("tasks[1].task");
  });
});
