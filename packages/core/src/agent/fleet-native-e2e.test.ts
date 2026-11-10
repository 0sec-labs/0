import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
import type { ToolContext } from "./types.js";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import { eventBus } from "../events/bus.js";
// No native-loop/dependency mocks: every child and descendant uses the real loop.
const roots: string[] = [], executors: ToolExecutor[] = [];
const releases: Array<() => void> = [];
const call = (id: string, name: string, input: Record<string, unknown>): NativeRuntimeResult => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } });
const denied = (): NativeRuntimeResult => ({ content: [], stopReason: "error", error: "Synthetic provider API request timed out; outcome may be unknown. Automatic replay is disabled.", durationMs: 0 });
type Script = (system: string, step: number, signal?: AbortSignal) => Promise<NativeRuntimeResult> | NativeRuntimeResult;
function runtime(script: Script, finish?: (system: string) => Promise<void>): NativeRuntime {
  let step = 0, lastSystem = "";
  return { type: "api", isAvailable: async () => true, resolvedModel: () => "synthetic-fleet-fixture",
    executeNative: async (system, _messages, _tools, _callbacks, signal) => { lastSystem = system; return script(system, step++, signal); },
    forkForSubagent: async () => runtime(script, finish), ...(finish ? { finishInvocation: () => finish(lastSystem) } : {}) };
}
function fixture(script: Script, finish?: (system: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "zero-fleet-native-e2e-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "tracked.txt"), "before\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Synthetic fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const rt = runtime(script, finish), home = join(root, "private-home");
  const context = { target: root, scanId: "fixture-parent", role: "attack", scopePath: root, workspaceRoot: root, autonomyMode: "yolo", consoleSession: true,
    findings: [], attackResults: [], targetInfo: {}, delegationSystemPrompt: "Offline synthetic fixture only.",
    delegationTools: [TOOL_DEFINITIONS.spawn_agent, TOOL_DEFINITIONS.str_replace, TOOL_DEFINITIONS.bash, TOOL_DEFINITIONS.done],
    agentMessaging: { selfId: "Main", selfRole: "parent", siblingChannelEnabled: true, operatorChannelEnabled: false, projectPath: root, homeDir: home } } as ToolContext;
  const tools = new ToolExecutor(context, undefined, undefined, rt.forkForSubagent?.bind(rt));
  executors.push(tools);
  return { root, tools };
}
async function list(tools: ToolExecutor) {
  const result = await tools.execute({ name: "spawn_agent", arguments: { op: "list" } });
  expect(result.success).toBe(true);
  return result.output as any;
}

beforeEach(() => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  vi.stubEnv("ZERO_NO_TELEMETRY", "1");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Unexpected fixture network access"); }));
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const tools of executors.splice(0)) await tools.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  eventBus.clear();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([false, true])("retains terminal provider failure with real checkout write=%s", async (write) => {
  const { root, tools } = fixture((_system, step) => write && step === 0 ? call("edit", "str_replace", { path: "tracked.txt", old_string: "before", new_string: "after" }) : denied());
  const result = await tools.execute({ name: "spawn_agent", arguments: { task: "FAILURE_FIXTURE", wait: true, max_turns: 3 } });
  expect(result.success).toBe(false);
  expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe(write ? "after\n" : "before\n");
  const roster = await list(tools);
  expect(roster.live).toBe(0);
  expect(roster.counts.failed).toBe(1);
  expect(roster.workers[0]).toMatchObject({ status: "failed", cleanup: "drained", effects: "unknown" });
  expect(roster.workers[0].error).toContain("outcome may be unknown");
  expect(roster.workers[0].localEffects).toEqual({ attempts: write ? 1 : 0, tools: write ? ["str_replace"] : [], observedWrites: write ? 1 : 0 });
  expect(roster.workers[0].workspace).toMatchObject({ writeCapable: true });
  expect(roster.workers[0].workspace.key).toBeTruthy();
});
it("enumerates real descendants of a parked parent and waits for observed descendant cleanup", async () => {
  let cleanupReached = false;
  const cleanup = Promise.withResolvers<void>();
  releases.push(cleanup.resolve);
  const script: Script = (system, step, signal) => {
    if (system.includes("GRANDCHILD_FIXTURE")) {
      return new Promise(resolve => { const stop = () => resolve({ content: [], stopReason: "error", cancelled: true, error: "Synthetic cancelled", durationMs: 0 }); if (signal?.aborted)
        stop();
      else
        signal?.addEventListener("abort", stop, { once: true }); });
    }
    if (step === 0)
      return call("spawn-grandchild", "spawn_agent", { task: "GRANDCHILD_FIXTURE", wait: false });
    return call("outer-done", "done", { summary: "Outer task completed; descendant retained" });
  };
  const { tools } = fixture(script, async (system) => { if (system.includes("GRANDCHILD_FIXTURE")) {
    cleanupReached = true;
    await cleanup.promise;
  } });
  const spawned = await tools.execute({ name: "spawn_agent", arguments: { task: "OUTER_FIXTURE", wait: false, read_only: true } });
  expect(spawned.success).toBe(true);
  let roster: any;
  await vi.waitFor(async () => { roster = await list(tools); expect(roster.workers).toHaveLength(2); expect(roster.workers.some((worker: any) => worker.depth === 2 && worker.live)).toBe(true); });
  const parent = roster.workers.find((worker: any) => worker.depth === 1), grandchild = roster.workers.find((worker: any) => worker.depth === 2);
  expect(grandchild.parentId).toBe(parent.id);
  expect(parent.workspace).toMatchObject({ writeCapable: false });
  expect(grandchild.workspace).toMatchObject({ key: parent.workspace.key, writeCapable: false });
  await vi.waitFor(async () => { const entry = (await list(tools)).workers.find((worker: any) => worker.id === parent.id); expect(entry).toMatchObject({ status: "parked", live: true, subtreeLive: true, cleanup: "pending" }); });
  let stopped = false;
  const stopping = tools.execute({ name: "spawn_agent", arguments: { op: "stop_all" } }).then(result => { stopped = true; return result; });
  await vi.waitFor(() => expect(cleanupReached).toBe(true));
  expect(stopped).toBe(false);
  cleanup.resolve();
  expect((await stopping).success).toBe(true);
  const drained = await list(tools);
  expect(drained.live).toBe(0);
  expect(drained.workers.every((worker: any) => worker.cleanup === "drained")).toBe(true);
  expect((await tools.execute({ name: "spawn_agent", arguments: { op: "stop", agent_id: "foreign-agent" } })).success).toBe(false);
});
it("stop drains a real mutation-capable shell before returning and prevents subsequent writes", async () => {
  const { root, tools } = fixture((_system, step) => step === 0 ? call("running-writer", "bash", { command: "while :; do printf x >> effects.log; sleep 0.02; done", timeout: 30 }) : denied());
  const started = await tools.execute({ name: "spawn_agent", arguments: { task: "RUNNING_WRITER_FIXTURE", wait: false } });
  expect(started.success).toBe(true);
  await vi.waitFor(() => expect(readFileSync(join(root, "effects.log"), "utf8").length).toBeGreaterThan(0));
  const stopping = await tools.execute({ name: "spawn_agent", arguments: { op: "stop_all" } });
  expect(stopping.success).toBe(true);
  const after = readFileSync(join(root, "effects.log"), "utf8");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(readFileSync(join(root, "effects.log"), "utf8")).toBe(after);
  expect((await list(tools)).live).toBe(0);
});
it("fails fast on a competing shared-checkout writer while allowing a restricted review peer", async () => {
  let executions = 0, writerWaiting = false;
  const { root, tools } = fixture((system, step, signal) => {
    executions++;
    if (system.includes("READ_ONLY_PEER"))
      return call("review-done", "done", { summary: "Read-only review complete" });
    if (step === 0)
      return call("writer-edit", "str_replace", { path: "tracked.txt", old_string: "before", new_string: "writer-held" });
    writerWaiting = true;
    return new Promise(resolve => { const stop = () => resolve({ content: [], stopReason: "error", cancelled: true, error: "Synthetic cancelled", durationMs: 0 }); if (signal?.aborted)
      stop();
    else
      signal?.addEventListener("abort", stop, { once: true }); });
  });
  const first = await tools.execute({ name: "spawn_agent", arguments: { task: "WRITER_HELD", wait: false } });
  expect(first.success).toBe(true);
  await vi.waitFor(() => expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("writer-held\n"));
  await vi.waitFor(() => expect(writerWaiting).toBe(true));
  const before = executions;
  const competing = await tools.execute({ name: "spawn_agent", arguments: { task: "COMPETING_WRITER", wait: false } });
  expect(competing.success).toBe(false);
  expect(executions).toBe(before);
  expect((await tools.execute({ name: "str_replace", arguments: { path: "tracked.txt", old_string: "writer-held", new_string: "parent-race" } })).success).toBe(false);
  const review = await tools.execute({ name: "spawn_agent", arguments: { task: "READ_ONLY_PEER", wait: false, read_only: true } });
  expect(review.success).toBe(true);
  await vi.waitFor(async () => expect((await list(tools)).workers).toHaveLength(2));
  const roster = await list(tools);
  expect(roster.workers.filter((worker: any) => worker.workspace.writeCapable)).toHaveLength(1);
  expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("writer-held\n");
  expect((await tools.execute({ name: "spawn_agent", arguments: { op: "stop_all" } })).success).toBe(true);
  expect((await tools.execute({ name: "str_replace", arguments: { path: "tracked.txt", old_string: "writer-held", new_string: "after-drain" } })).success).toBe(true);
  expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("after-drain\n");
});
it("cannot regain a mutation tool by requesting it from a restricted read-only worker", async () => {
  const { root, tools } = fixture((_system, step) => step === 0 ? call("forbidden-edit", "str_replace", { path: "tracked.txt", old_string: "before", new_string: "forbidden" }) : denied());
  await tools.execute({ name: "spawn_agent", arguments: { task: "ROGUE_READ_ONLY", wait: true, read_only: true, max_turns: 3 } });
  expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("before\n");
  const worker = (await list(tools)).workers[0];
  expect(worker.workspace.writeCapable).toBe(false);
  expect(worker.localEffects.observedWrites).toBe(0);
});
it("reports eleven real admitted review workers separately from four model execution slots", async () => {
  vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "4");
  let calls = 0;
  const { tools } = fixture((_system, _step, signal) => {
    calls++;
    return new Promise(resolve => { const stop = () => resolve({ content: [], stopReason: "error", cancelled: true, error: "Synthetic cancelled", durationMs: 0 }); if (signal?.aborted)
      stop();
    else
      signal?.addEventListener("abort", stop, { once: true }); });
  });
  const spawned = await tools.execute({ name: "spawn_agent", arguments: { tasks: Array.from({ length: 11 }, (_, index) => ({ task: `READ_ONLY_COUNTED_${index}`, read_only: true })), wait: false } });
  expect(spawned.success).toBe(true);
  await vi.waitFor(() => expect(calls).toBe(4));
  const roster = await list(tools);
  expect(roster).toMatchObject({ live: 11, counts: { running: 4, queued: 7 } });
  expect(roster.workers).toHaveLength(11);
  expect(new Set(roster.workers.map((worker: any) => worker.id)).size).toBe(11);
  expect(roster.workers.every((worker: any) => worker.workspace.writeCapable === false)).toBe(true);
  expect((await tools.execute({ name: "spawn_agent", arguments: { op: "stop_all" } })).success).toBe(true);
  expect(await list(tools)).toMatchObject({ live: 0, retainedTerminal: 11, counts: { stopped: 11 } });
  expect(calls).toBe(4);
});
