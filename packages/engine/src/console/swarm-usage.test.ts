import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import { createConsoleSession, type ConsoleUsageReport } from "./turn-engine.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function isolatedHome() { const root = mkdtempSync(join(tmpdir(), "0-swarm-usage-")); roots.push(root); vi.stubEnv("HOME", root); return root; }
function done(usage = { inputTokens: 20, outputTokens: 2 }): NativeRuntimeResult {
  return { content: [{ type: "text", text: "Inspection complete." }], stopReason: "end_turn", durationMs: 0, usage };
}

it("includes recursive child usage once with actual model and cache breakdowns", async () => {
  isolatedHome();
  const reports: ConsoleUsageReport[] = [];
  const atDepth = (depth: number): NativeRuntime => {
    let turn = 0;
    return {
      type: "api", isAvailable: async () => true, resolvedModel: () => depth ? "gpt-5.6-sol" : "gpt-4o",
      forkForSubagent: async () => atDepth(depth + 1),
      executeNative: async (_system, _messages, _tools, callbacks) => {
        turn++;
        if (depth === 0) return turn === 1
          ? { content: [{ type: "tool_use", id: "spawn", name: "spawn_agent", input: { task: "Delegate focused inspection", max_turns: 2, read_only: true } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 10, outputTokens: 1 } }
          : { content: [{ type: "text", text: "Combined inspection finished." }], stopReason: "end_turn", durationMs: 0, usage: { inputTokens: 10, outputTokens: 1 } };
        if (depth === 1 && turn === 1) return { content: [{ type: "tool_use", id: "nested", name: "spawn_agent", input: { task: "Inspect one independent detail", max_turns: 1 } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 20, outputTokens: 2 } };
        if (depth === 2) {
          callbacks?.onUsage?.({ inputTokens: 30, outputTokens: 3, cachedInputTokens: 20, cacheWriteTokens: 5 });
          return { ...done({ inputTokens: 30, outputTokens: 3 }), usageByModel: [
          { model: "gpt-4o", usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 5 } },
          { model: "gpt-4.1", usage: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 15, cacheWriteTokens: 5 } },
          ] };
        }
        return done();
      },
    };
  };
  const session = createConsoleSession({ runtime: atDepth(0), role: "audit", toolset: "full" });
  try {
    const outcome = await session.send("Investigate in a small coordinated team.", { onUsage: report => reports.push(report) });
    expect(outcome.usage).toEqual({ inputTokens: 90, outputTokens: 9 });
    expect(reports.reduce((sum, report) => sum + report.inputTokens + report.outputTokens, 0)).toBe(99);
    const workers = reports.filter(report => report.kind === "worker");
    expect(workers.map(report => report.model)).toEqual(["gpt-5.6-sol", "gpt-4o", "gpt-4.1", "gpt-5.6-sol"]);
    expect(workers.reduce((sum, report) => sum + (report.cachedInputTokens ?? 0), 0)).toBe(20);
    expect(workers.reduce((sum, report) => sum + (report.cacheWriteTokens ?? 0), 0)).toBe(5);
    expect(outcome.contextInputTokens).toBe(10);
  } finally { await session.cleanup(); }
});

function parentWithChild(child: NativeRuntime, afterInitial?: (call: number) => Promise<void>): NativeRuntime {
  let calls = 0;
  return {
    type: "api", isAvailable: async () => true, resolvedModel: () => "gpt-4o", forkForSubagent: async () => child,
    executeNative: async () => {
      calls++;
      if (calls === 1) return { content: [{ type: "tool_use", id: "spawn", name: "spawn_agent", input: { task: "Inspect a bounded detail", max_turns: 3 } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 10, outputTokens: 1 } };
      await afterInitial?.(calls);
      return { content: [{ type: "text", text: "Parent completed." }], stopReason: "end_turn", durationMs: 0, usage: { inputTokens: 10, outputTokens: 1 } };
    },
  };
}

it("allows a three-worker batch without approval", async () => {
  isolatedHome();
  const approveTool = vi.fn(async () => false);
  let parentCalls = 0;
  let childCalls = 0;
  const runtime: NativeRuntime = {
    type: "api", isAvailable: async () => true,
    forkForSubagent: async () => ({
      type: "api", isAvailable: async () => true,
      executeNative: async () => { childCalls++; return done(); },
    }),
    executeNative: async () => {
      parentCalls++;
      return parentCalls % 2 === 1
        ? {
          content: [{ type: "tool_use", id: `batch-${parentCalls}`, name: "spawn_agent", input: {
            tasks: [1, 2, 3].map(index => ({ task: `Read existing evidence for check ${index}.`, read_only: true, max_turns: 1 })),
            wait: true,
          } }],
          stopReason: "tool_use", durationMs: 0,
        }
        : { content: [{ type: "text", text: "Evidence review finished." }], stopReason: "end_turn", durationMs: 0 };
    },
  };
  const session = createConsoleSession({ runtime, approveTool });
  try {
    const allowed = await session.send("Review existing evidence with three workers.");
    expect(allowed.toolCalls[0].call.name).toBe("spawn_agent");
    expect(allowed.toolCalls[0].result.success).toBe(true);
    expect(childCalls).toBe(3);
    expect(approveTool).not.toHaveBeenCalled();
  } finally { await session.cleanup(); }
});

it("counts streamed child usage once when the request subsequently fails", async () => {
  isolatedHome();
  const reports: ConsoleUsageReport[] = [];
  const child: NativeRuntime = { type: "api", isAvailable: async () => true, resolvedModel: () => "gpt-4.1", executeNative: async (_system, _messages, _tools, callbacks) => {
    callbacks?.onUsage?.({ inputTokens: 7, outputTokens: 2, cachedInputTokens: 3 });
    throw new Error("OpenAI API error 401: invalid_api_key");
  } };
  const session = createConsoleSession({ runtime: parentWithChild(child) });
  try {
    const outcome = await session.send("Delegate one check.", { onUsage: usage => reports.push(usage) });
    expect(outcome.usage).toEqual({ inputTokens: 27, outputTokens: 4 });
    expect(reports.filter(report => report.kind === "worker")).toMatchObject([{ model: "gpt-4.1", inputTokens: 7, outputTokens: 2, cachedInputTokens: 3 }]);
  } finally { await session.cleanup(); }
});

it("marks missing worker usage unknown instead of fabricating a free request", async () => {
  isolatedHome();
  const reports: ConsoleUsageReport[] = [];
  const child: NativeRuntime = { type: "api", isAvailable: async () => true, resolvedModel: () => "gpt-4.1", executeNative: async () => {
    const result = done(); delete result.usage; return result;
  } };
  const session = createConsoleSession({ runtime: parentWithChild(child) });
  try {
    await session.send("Delegate one check.", { onUsage: usage => reports.push(usage) });
    expect(reports.filter(report => report.kind === "worker")).toMatchObject([{ model: "gpt-4.1", inputTokens: 0, outputTokens: 0, usageUnavailable: true }]);
  } finally { await session.cleanup(); }
});

it("stops admitting child requests after the active parent token allowance is spent", async () => {
  isolatedHome();
  let childCalls = 0;
  const child: NativeRuntime = { type: "api", isAvailable: async () => true, resolvedModel: () => "gpt-4.1", executeNative: async () => {
    childCalls++;
    return { content: [{ type: "tool_use", id: "status", name: "report_status", input: { note: "Examining bounded evidence" } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 200_000, outputTokens: 1 } };
  } };
  const session = createConsoleSession({ runtime: parentWithChild(child), maxTurnTokens: 200_000 });
  try {
    const outcome = await session.send("Delegate one check.");
    expect(outcome.stopReason).toBe("max_turn_tokens");
    expect(childCalls).toBe(1);
    // A dispatched request may overshoot; this is not a hard billing cap.
    expect(outcome.budget.tokensUsed).toBe(200_012);
  } finally { await session.cleanup(); }
});
