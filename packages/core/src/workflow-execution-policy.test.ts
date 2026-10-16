import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor, getToolsForRole, TOOL_DEFINITIONS } from "./agent/tools.js";
import { runNativeAgentLoop } from "./agent/native-loop.js";
import { runPipeline } from "./unified-pipeline.js";
import { runSelectedStaticScan } from "./shared-analysis.js";
import type { NativeRuntime, NativeToolDef } from "./runtime/types.js";
import { assertWorkflowNativeRuntime, getWorkflowAuditExecutionPolicy, withWorkflowAuditExecutionPolicy, workflowPolicyRuntime } from "./workflow-execution-policy.js";

const launchStatic = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFileSync: launchStatic }));

let home: string;
beforeEach(() => {
  launchStatic.mockReset();
  home = realpathSync(mkdtempSync(join(tmpdir(), "zero-phase-policy-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("workflow phase agent policy", () => {
  it("blocks unadvertised tool dispatch and does not exempt done for an explicit empty list", async () => {
    const executor = new ToolExecutor({ target: "https://example.test", scanId: "phase", findings: [], attackResults: [], targetInfo: {} }, null);
    await withWorkflowAuditExecutionPolicy({ instructions: "Read only", allowedAgentTools: [] }, async () => {
      expect(getToolsForRole("audit")).toEqual([]);
      expect(await executor.execute({ name: "run_command", arguments: { command: `touch ${join(home, "unexpected")}` } })).toMatchObject({ success: false, error: expect.stringContaining("not allowed in this workflow phase") });
      expect(await executor.execute({ name: "done", arguments: { summary: "Finished" } })).toMatchObject({ success: false });
    });
    expect(existsSync(join(home, "unexpected"))).toBe(false);
    expect(getWorkflowAuditExecutionPolicy()).toBeUndefined();
  });

  it("inherits async descendants, intersects nested allowlists, and isolates concurrent phases", async () => {
    const executor = new ToolExecutor({ target: "https://example.test", scanId: "child", findings: [], attackResults: [], targetInfo: {} }, null);
    await Promise.all([
      withWorkflowAuditExecutionPolicy({ instructions: "Parent focus", allowedAgentTools: ["done"] }, async () => {
        await Promise.resolve();
        await withWorkflowAuditExecutionPolicy({ instructions: "Child focus", allowedAgentTools: ["done", "run_command"] }, async () => {
          expect(getWorkflowAuditExecutionPolicy()?.allowedAgentTools).toEqual(["done"]);
          expect(await executor.execute({ name: "run_command", arguments: { command: "pwd" } })).toMatchObject({ success: false });
        });
      }),
      withWorkflowAuditExecutionPolicy({ instructions: "Other phase" }, async () => {
        await Promise.resolve();
        expect(getToolsForRole("audit").some(tool => tool.name === "done")).toBe(true);
        expect(getWorkflowAuditExecutionPolicy()?.instructions).toBe("Other phase");
      }),
    ]);
  });

  it("injects phase instructions and denies a dishonest native model's unadvertised command", async () => {
    const observed: { system: string; tools: NativeToolDef[] }[] = [];
    let turn = 0;
    const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async (system, _messages, tools) => {
      observed.push({ system, tools });
      return { content: ++turn === 1 ? [{ type: "tool_use", id: "bad", name: "run_command", input: { command: `touch ${join(home, "unexpected")}` } }] : [{ type: "tool_use", id: "finish", name: "done", input: { summary: "Complete" } }], stopReason: "tool_use", durationMs: 0 };
    } };
    const state = await withWorkflowAuditExecutionPolicy({ instructions: "Inspect authorization boundaries", allowedAgentTools: ["done"] }, () => runNativeAgentLoop({
      runtime, db: null, config: { role: "discovery", target: "https://example.test", scanId: "phase-native", maxTurns: 2, tools: [TOOL_DEFINITIONS.run_command, TOOL_DEFINITIONS.done], systemPrompt: "Existing security policy", allowModelSelfExtension: false, codebaseLearning: false },
    }));
    expect(observed[0].system).toContain("Inspect authorization boundaries");
    expect(observed[0].tools.map(tool => tool.name)).toEqual(["done"]);
    expect(JSON.stringify(state.messages)).toContain("not allowed in this workflow phase");
    expect(existsSync(join(home, "unexpected"))).toBe(false);
  });

  it("keeps the same allowlist in a real spawned native agent", async () => {
    const systems: string[] = [];
    const atDepth = (depth: number): NativeRuntime => {
      let turn = 0;
      return { type: "api", isAvailable: async () => true, forkForSubagent: async () => atDepth(depth + 1), executeNative: async (system) => {
        systems.push(system);
        return { content: ++turn === 1 ? depth === 0 ? [{ type: "tool_use", id: "delegate", name: "spawn_agent", input: { task: "Inspect bounded target", max_turns: 2 } }] : [{ type: "tool_use", id: "child-bad", name: "run_command", input: { command: `touch ${join(home, "child-unexpected")}` } }] : [{ type: "tool_use", id: `done-${depth}`, name: "done", input: { summary: "Done" } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } };
      } };
    };
    const state = await withWorkflowAuditExecutionPolicy({ instructions: "No command execution", allowedAgentTools: ["spawn_agent", "done"] }, () => runNativeAgentLoop({
      runtime: atDepth(0), db: null, config: { role: "discovery", target: "https://example.test", scanId: "phase-parent", maxTurns: 2, tools: [TOOL_DEFINITIONS.spawn_agent, TOOL_DEFINITIONS.done], systemPrompt: "Parent policy", allowModelSelfExtension: false, codebaseLearning: false },
    }));
    expect(systems.length).toBeGreaterThan(2);
    expect(systems.every(system => system.includes("No command execution"))).toBe(true);
    expect(existsSync(join(home, "child-unexpected"))).toBe(false);
    expect(state.done).toBe(true);
  });

  it("rejects incompatible runtimes before deterministic pipeline preparation", async () => {
    await expect(withWorkflowAuditExecutionPolicy({ instructions: "Restricted phase", allowedAgentTools: [] }, () => runPipeline({ target: join(home, "nonexistent"), depth: "default", format: "json", runtime: "claude" }))).rejects.toThrow("native API runtime");
    withWorkflowAuditExecutionPolicy({ instructions: "Restricted phase" }, () => expect(() => assertWorkflowNativeRuntime({ type: "api" })).toThrow("legacy fallback"));
    expect(existsSync(join(home, ".0", "runs"))).toBe(false);
  });

  it("keeps deterministic pipeline scanning separate from the agent tool allowlist", () => {
    vi.stubEnv("ZERO_STATIC", "semgrep");
    const launch = launchStatic.mockReturnValue('{"results":[]}');
    withWorkflowAuditExecutionPolicy({ instructions: "Agent has no tools", allowedAgentTools: [] }, () => {
      expect(getToolsForRole("audit", { allowScanners: true })).toEqual([]);
      expect(runSelectedStaticScan(home, () => undefined)).toEqual([]);
    });
    expect(launch).toHaveBeenCalledWith("semgrep", expect.arrayContaining(["scan", home]), expect.any(Object));
  });

  it("decorates direct report calls and forked runtimes without granting tools", async () => {
    const native = vi.fn(async () => ({ content: [], stopReason: "end_turn" as const, durationMs: 0 }));
    const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: native, forkForSubagent: async () => runtime };
    await withWorkflowAuditExecutionPolicy({ instructions: "Prioritize tenant boundaries", allowedAgentTools: [] }, async () => {
      const wrapped = workflowPolicyRuntime(runtime);
      await wrapped.executeNative("Summarize findings", [], [{ name: "run_command", description: "Command", inputSchema: {} } as NativeToolDef]);
      const fork = await wrapped.forkForSubagent!(1000);
      await fork.executeNative("Verify", [], []);
    });
    expect(native.mock.calls[0][0]).toContain("Prioritize tenant boundaries");
    expect(native.mock.calls[0][2]).toEqual([]);
    expect(native.mock.calls[1][0]).toContain("Prioritize tenant boundaries");
  });
});
