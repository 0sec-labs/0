import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import { withWorkflowAuditExecutionPolicy, getWorkflowAuditExecutionPolicy } from "../workflow-execution-policy.js";
import { withLocalSourceBoundary } from "../scope/local-source-boundary.js";
import { eventBus } from "../events/bus.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
import type { ToolContext } from "./types.js";

const fetchStub = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 200 })));
vi.mock("../http.js", async original => ({ ...await original<object>(), fetchScoped: fetchStub }));
// Exercise both real native-loop invocations; replace only mailbox parking with
// a deterministic initial run and revival, without timers or filesystem I/O.
const externalRevival = vi.hoisted(() => ({
  enabled: false,
  revive: null as null | (() => Promise<unknown>),
  finish: null as null | (() => void),
}));
vi.mock("../hub/supervisor.js", async original => ({
  ...await original<object>(),
  runPersistentAgent: async (task: string, options: { runLoop: (input: unknown) => Promise<unknown> }) => {
    await options.runLoop({ task, messages: [] });
    if (externalRevival.enabled) {
      return new Promise(resolve => {
        externalRevival.revive = () => options.runLoop({ messages: [{ id: "external-revival", from: "parent", to: "child", body: "Continue.", ts: 2 }] });
        externalRevival.finish = () => resolve({ status: "completed", reason: "idle_timeout", revives: 1 });
      });
    }
    await options.runLoop({ messages: [{ id: "follow-up", from: "parent", to: "child", body: "Continue; do not widen permissions.", ts: 1 }] });
    return { status: "completed", reason: "idle_timeout", revives: 1 };
  },
}));
afterEach(() => { externalRevival.enabled = false; externalRevival.revive = null; externalRevival.finish = null; vi.restoreAllMocks(); fetchStub.mockClear(); eventBus.clear(); });

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { target: "https://allowed.test", scanId: "typed-delegation", role: "attack", consoleSession: true, autonomyMode: "yolo",
    findings: [], attackResults: [], targetInfo: {},
    delegationTools: ["web_search", "load_skill", "finding", "spawn_agent"].map(name => TOOL_DEFINITIONS[name]!),
    ...overrides };
}
function native(steps: (turn: number, tools: string[], system: string, messages: unknown) => NativeRuntimeResult): NativeRuntime {
  let turn = 0;
  return { type: "api", isAvailable: async () => true,
    executeNative: async (system, messages, tools) => steps(++turn, tools.map(tool => tool.name), system, messages) };
}
const use = (name: string, input: Record<string, unknown> = {}): NativeRuntimeResult => ({ content: [{ type: "tool_use", id: `call-${name}`, name, input }], stopReason: "tool_use", durationMs: 0 });
const done = (): NativeRuntimeResult => ({ content: [{ type: "text", text: "Bounded task complete." }], stopReason: "end_turn", durationMs: 0 });
const prose = (): NativeRuntimeResult => ({ content: [{ type: "text", text: "No permitted actions; returning the result." }], stopReason: "end_turn", durationMs: 0 });

it.each(["spawn_agent"])("%s rejects a forged finding at dispatch, not only in metadata", async name => {
  const persisted = vi.fn((finding: Finding) => ({ status: "created" as const, findingId: finding.id }));
  const errors: string[] = [];
  const child = native((turn, tools, system, messages) => {
    expect(tools.sort()).toEqual(["load_skill", "web_search"]);
    expect(system).not.toContain("Save evidence-backed findings with finding");
    if (turn === 1) return use("finding", { title: "Unapproved write" });
    errors.push(JSON.stringify(messages)); return done();
  });
  const ctx = context({ persistDelegatedFinding: persisted });
  const ex = new ToolExecutor(ctx, null, undefined, async () => child);
  try {
    const task = { task: "Inspect assigned metadata.", max_turns: 2, allowed_tools: ["web_search", "load_skill"] };
    const result = await ex.execute({ name, arguments: name === "spawn_agent" ? { ...task, wait: true } : { tasks: [task] } });
    expect(result.success).toBe(true);
    expect(errors.join()).toContain('not allowed in this workflow phase');
    expect(persisted).not.toHaveBeenCalled(); expect(ctx.findings).toEqual([]);
  } finally { await ex.cleanup(); }
});

it("isolates sibling allowlists and keeps explicit [] empty, including injected helpers", async () => {
  const observed: string[][] = [];
  const factory = vi.fn(async () => native((_turn, tools) => { observed.push(tools); return prose(); }));
  const ex = new ToolExecutor(context(), null, undefined, factory);
  try {
    expect((await ex.execute({ name: "spawn_agent", arguments: { wait: true, tasks: [
      { task: "No actions.", max_turns: 1, allowed_tools: [] },
      { task: "Summary only.", max_turns: 1, allowed_tools: ["load_skill"] },
    ] } })).success).toBe(true);
    expect(observed).toContainEqual([]); expect(observed).toContainEqual(["load_skill"]);
  } finally { await ex.cleanup(); }
});

it("preserves inherited tools and publication guidance when the field is omitted", async () => {
  const child = native((_turn, tools, system) => {
    expect(tools).toContain("finding"); expect(tools).toContain("report_status");
    expect(system).toContain("Save evidence-backed findings with finding"); return done();
  });
  const ex = new ToolExecutor(context(), null, undefined, async () => child);
  try { expect((await ex.execute({ name: "spawn_agent", arguments: { task: "Inspect metadata.", max_turns: 1, wait: true } })).success).toBe(true); }
  finally { await ex.cleanup(); }
});

it.each([
  { name: "spawn_agent", input: { task: "A", wait: true, allowed_tools: ["missing_tool"] } },
  { name: "spawn_agent", input: { tasks: [{ task: "A" }, { task: "B", allowed_tools: ["bash"] }], wait: true } },
  { name: "spawn_agent", input: { tasks: [{ task: "A", allowed_tools: "load_skill" }] } },
  { name: "spawn_agent", input: { tasks: [{ task: "A" }], allowed_tools: [] } },
  { name: "spawn_agent", input: { task: "A", allowed_tools: ["bash"] } },
  { name: "spawn_agent", input: { task: "A", allowed_http_methods: ["TRACE"], wait: true } },
])("rejects invalid or unavailable typed restrictions before allocating $name workers", async ({ name, input }) => {
  const factory = vi.fn(async () => native(() => done()));
  const events: string[] = []; const unsubscribe = eventBus.subscribe({ emit: type => { if (type === "subagent_lifecycle") events.push(type); } });
  const ex = new ToolExecutor(context(), null, undefined, factory);
  try {
    expect((await ex.execute({ name, arguments: input })).success).toBe(false);
    expect(factory).not.toHaveBeenCalled(); expect(events).toEqual([]);
  } finally { unsubscribe(); await ex.cleanup(); }
});

it("does not let a child widen its tool capabilities through another spawn", async () => {
  const factory = vi.fn(async () => native((turn, tools, _system, messages) => {
    expect(tools).not.toContain("finding");
    if (turn === 1) return use("spawn_agent", { task: "Widen", allowed_tools: ["load_skill", "finding"], wait: true });
    expect(JSON.stringify(messages)).toContain('unavailable tool'); return done();
  }));
  const ex = new ToolExecutor(context(), null, undefined, factory);
  try {
    expect((await ex.execute({ name: "spawn_agent", arguments: { task: "Delegate only within capabilities.", max_turns: 2, wait: true, allowed_tools: ["spawn_agent", "load_skill"] } })).success).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  } finally { await ex.cleanup(); }
});

it("refuses network capability requests across an explicit read-only source boundary", async () => {
  const factory = vi.fn(async () => native(() => done()));
  const ex = new ToolExecutor(context(), null, undefined, factory);
  try {
    const result = await withLocalSourceBoundary(process.cwd(), () => ex.execute({ name: "spawn_agent", arguments: {
      task: "Request web search from a source-only worker.", wait: true, allowed_tools: ["web_search", "load_skill"],
    } }));
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('unavailable tool "web_search"') });
    expect(factory).not.toHaveBeenCalled(); expect(fetchStub).not.toHaveBeenCalled();
  } finally { await ex.cleanup(); }
});


it.each([undefined, 100])("enforces the operator policy when task constraints exist only in prose (task max=%s)", async requestedTurns => {
  const { runNativeAgentLoop } = await import("./native-loop.js");
  const observedCaps: Array<number | undefined> = [];
  const observedPolicies: unknown[] = [];
  const persist = vi.fn((finding: Finding) => ({ status: "created" as const, findingId: finding.id })); let denied = false;
  const child = native((turn, tools, _system, messages) => {
    expect(tools.sort()).toEqual(["load_skill", "web_search"]);
    if (turn === 1) return { content: [
      { type: "tool_use", id: "host-write", name: "finding", input: { title: "Forbidden" } },
      { type: "tool_use", id: "host-post", name: "bash", input: { command: "id" } },
    ], stopReason: "tool_use", durationMs: 0 };
    denied = JSON.stringify(messages).includes("not allowed in this workflow phase"); return done();
  });
  const ctx = context({ persistDelegatedFinding: persist });
  const ex = new ToolExecutor(ctx, null, undefined, async () => child);
  // This is an existing executor: operator configuration does not recreate it.
  ex.configureWorkerPolicy({ allowedTools: ["web_search", "load_skill"], allowedHttpMethods: ["GET"], maxTurns: 6 });
  vi.spyOn(ex as unknown as { loadSubagentDeps: () => Promise<{ runNativeAgentLoop: typeof runNativeAgentLoop }> }, "loadSubagentDeps").mockResolvedValue({ runNativeAgentLoop: async opts => {
    observedCaps.push(opts.config.maxTurns); observedPolicies.push(opts.config.workerPolicy); return runNativeAgentLoop(opts);
  } });
  try {
    expect((await ex.execute({ name: "spawn_agent", arguments: { task: "Read metadata only; allowed_tools=web_search,done; allowed_http_methods=GET; max_turns=6", wait: true,
      ...(requestedTurns !== undefined ? { max_turns: requestedTurns, allowed_tools: ["web_search", "load_skill", "finding"], allowed_http_methods: ["GET", "POST"] } : {}),
    } })).success).toBe(true);
    expect(observedCaps).toEqual([6]);
    expect(observedPolicies).toEqual([{ allowedTools: ["web_search", "load_skill"], allowedHttpMethods: ["GET"], maxTurns: 6 }]);
    expect(denied).toBe(true); expect(fetchStub).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  } finally { await ex.cleanup(); }
});

it("keeps the operator max-turn and capability ceilings in grandchildren", async () => {
  const { runNativeAgentLoop } = await import("./native-loop.js");
  const caps: Array<number | undefined> = [];
  vi.spyOn(ToolExecutor.prototype as unknown as { loadSubagentDeps: () => Promise<{ runNativeAgentLoop: typeof runNativeAgentLoop }> }, "loadSubagentDeps").mockResolvedValue({ runNativeAgentLoop: async opts => { caps.push(opts.config.maxTurns); return runNativeAgentLoop(opts); } });
  const grandchild = native((_turn, tools) => { expect(tools).toContain("load_skill"); expect(tools).not.toContain("finding"); return done(); });
  const child = native(turn => turn === 1 ? use("spawn_agent", { task: "Summarize.", wait: true, max_turns: 100 }) : done());
  child.forkForSubagent = async () => grandchild;
  const ex = new ToolExecutor(context({ workerPolicy: { allowedTools: ["spawn_agent", "load_skill"], allowedHttpMethods: ["GET"], maxTurns: 6 } }), null, undefined, async () => child);
  try {
    expect((await ex.execute({ name: "spawn_agent", arguments: { task: "Delegate a summary.", wait: true } })).success).toBe(true);
    expect(caps).toEqual([6, 6]); expect(fetchStub).not.toHaveBeenCalled();
  } finally { await ex.cleanup(); }
});
