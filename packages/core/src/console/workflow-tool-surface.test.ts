import { describe, expect, it, vi } from "vitest";
import { createConsoleSession, getWorkflowLifecycleTools } from "./turn-engine.js";
import type { NativeRuntime } from "../runtime/types.js";

describe("workflow tool surface", () => {
  it("offers one draft API when both authoring and lifecycle storage are attached", async () => {
    const session = createConsoleSession({
      runtime: { type: "api", isAvailable: async () => true, executeNative: vi.fn() },
      allowModelSelfExtension: false,
      tools: [],
      workflowAuthoring: { list: () => [], save: vi.fn() },
      workflowLifecycle: { invoke: vi.fn() },
    });
    try {
      const names = session.tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(["console_list_workflows", "console_save_workflow", "list_templates", "start_run", "list_schedules"]));
      expect(names).not.toContain("list_workflows");
      expect(names).not.toContain("get_workflow");
      expect(names).not.toContain("save_workflow");
    } finally { await session.cleanup(); }
  });

  it("retains draft operations for lifecycle-only callers", () => {
    expect(getWorkflowLifecycleTools(false).map(tool => tool.name)).toEqual(expect.arrayContaining(["list_workflows", "get_workflow", "save_workflow"]));
    expect(getWorkflowLifecycleTools(true)).toHaveLength(getWorkflowLifecycleTools(false).length - 3);
  });

  it("keeps legacy lifecycle calls dispatchable without advertising duplicate schemas", async () => {
    const invoke = vi.fn(async () => ({ workflows: [] }));
    let round = 0;
    const runtime: NativeRuntime = {
      type: "api", isAvailable: async () => true,
      executeNative: async () => ++round === 1
        ? { content: [{ type: "tool_use", id: "legacy", name: "list_workflows", input: {} }], stopReason: "tool_use", durationMs: 1 }
        : { content: [{ type: "text", text: "Done." }], stopReason: "end_turn", durationMs: 1 },
    };
    const session = createConsoleSession({ runtime, refineObjective: false, tools: [], allowModelSelfExtension: false,
      workflowAuthoring: { list: () => [], save: vi.fn() }, workflowLifecycle: { invoke } });
    try {
      await session.send("List the workflows.");
      expect(invoke).toHaveBeenCalledWith("list_workflows", {});
    } finally { await session.cleanup(); }
  });
});
