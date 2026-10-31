import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleSession } from "./turn-engine.js";
import { ToolExecutor, TOOL_DEFINITIONS, getToolsForRole } from "../agent/tools.js";
import { AuditWorkerTree } from "../agent/worker-tree.js";
import { DeferredToolRegistry } from "../agent/deferred-tools.js";
import type { ToolContext } from "../agent/types.js";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";

const transport = vi.hoisted(() => vi.fn(async () => new Response('<a class="result__a" href="https://example.test/doc">Documentation</a>')));
vi.mock("../agent/tools/web-search-parallel.js", () => ({ searchParallel: async () => ({ ok: false, error: "Unavailable fixture" }) }));
vi.mock("../http.js", async original => ({ ...await original<object>(), fetchScoped: transport }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); transport.mockClear(); });
const context = (enabled: boolean): ToolContext => ({ target: "https://target.test", scanId: "search-policy", findings: [], attackResults: [], targetInfo: {}, autonomyMode: "yolo", webSearchEnabled: enabled });
const end = (): NativeRuntimeResult => ({ content: [{ type: "text", text: "Done" }], stopReason: "end_turn", durationMs: 0 });
function runtime(script: NativeRuntimeResult[]) {
  const executeNative = vi.fn<NativeRuntime["executeNative"]>(async () => script.shift() ?? end());
  return { type: "api" as const, isAvailable: async () => true, executeNative };
}

describe("per-chat built-in web search", () => {
  it("defaults new chats and role tools to search on while preserving an explicit chat opt-out", async () => {
    vi.stubEnv("ZERO_FEATURE_WEB_SEARCH", undefined);
    expect(getToolsForRole("audit").some(tool => tool.name === "web_search")).toBe(true);
    const enabled = createConsoleSession({ runtime: runtime([]), refineObjective: false, allowModelSelfExtension: false });
    const disabled = createConsoleSession({ runtime: runtime([]), webSearchEnabled: false, refineObjective: false, allowModelSelfExtension: false });
    try {
      await Promise.all([enabled.ready, disabled.ready]);
      expect(enabled.webSearchEnabled).toBe(true);
      expect(enabled.tools.some(tool => tool.name === "web_search")).toBe(true);
      expect(disabled.webSearchEnabled).toBe(false);
      expect(disabled.tools.some(tool => tool.name === "web_search")).toBe(false);
    } finally { await Promise.all([enabled.cleanup(), disabled.cleanup()]); }
  });
  it.each([false, true])("preserves the existing host default when omitted (%s)", async enabled => {
    vi.stubEnv("ZERO_FEATURE_WEB_SEARCH", enabled ? "1" : "0");
    const session = createConsoleSession({ runtime: runtime([]), refineObjective: false, allowModelSelfExtension: false });
    try { await session.ready; expect(session.webSearchEnabled).toBe(enabled); }
    finally { await session.cleanup(); }
  });
  it("requires live workers to finish before their inherited policy changes", async () => {
    const tree = new AuditWorkerTree("search-policy");
    const ctx = { ...context(true), workerTree: tree };
    const executor = new ToolExecutor(ctx, null);
    const child = tree.acquire("child", "search-policy");
    try {
      expect(() => executor.configureWebSearch(false)).toThrow("Finish active agents");
      expect(ctx.webSearchEnabled).toBe(true);
      child.release();
      executor.configureWebSearch(false);
      expect(ctx.webSearchEnabled).toBe(false);
    } finally { child.release(); await tree.close(); await executor.cleanup(); }
  });
  it("blocks guessed and previously loaded search calls before any transport", async () => {
    vi.stubEnv("ZERO_FEATURE_WEB_SEARCH", "1");
    const ctx = context(false);
    const registry = new DeferredToolRegistry(); registry.seed([TOOL_DEFINITIONS.web_search!]); registry.load(["web_search"]);
    Object.assign(ctx, { deferredTools: registry });
    const executor = new ToolExecutor(ctx, null);
    expect((await executor.execute({ name: "web_search", arguments: { query: "documentation" } })).error).toContain("disabled for this chat");
    expect(transport).not.toHaveBeenCalled();
    await executor.cleanup();
  });
  it("enables search for only the selected chat without changing the global default", async () => {
    vi.stubEnv("ZERO_FEATURE_WEB_SEARCH", "0");
    expect(getToolsForRole("audit").some(tool => tool.name === "web_search")).toBe(false);
    expect(getToolsForRole("audit", { webSearchEnabled: true }).some(tool => tool.name === "web_search")).toBe(true);
    const enabled = new ToolExecutor(context(true), null);
    await enabled.execute({ name: "web_search", arguments: { query: "documentation" } });
    expect(transport).toHaveBeenCalledOnce();
    await enabled.cleanup();
  });
  it("does not disable target HTTP tools or mutate target authorization", async () => {
    const ctx = context(false); const target = ctx.target;
    const executor = new ToolExecutor(ctx, null);
    await executor.execute({ name: "http_request", arguments: { url: target, method: "GET" } });
    expect(transport).toHaveBeenCalledOnce(); expect(ctx.target).toBe(target); expect(ctx.scope).toBeUndefined();
    await executor.cleanup();
  });
  it("hides search, rejects a guessed planner call, and supports idle reconfiguration/checkpoints", async () => {
    const model = runtime([{ content: [{ type: "tool_use", id: "guess", name: "web_search", input: { query: "documentation" } }], stopReason: "tool_use", durationMs: 0 }, end()]);
    const session = createConsoleSession({ runtime: model, webSearchEnabled: false, refineObjective: false, allowModelSelfExtension: false });
    await session.ready;
    try {
      expect(session.tools.some(tool => tool.name === "web_search")).toBe(false);
      await session.send("Investigate");
      expect(transport).not.toHaveBeenCalled();
      await session.setWebSearchEnabled!(true);
      expect(session.webSearchEnabled).toBe(true);
      expect(session.tools.some(tool => tool.name === "web_search")).toBe(true);
      expect(session.exportCheckpoint().webSearchEnabled).toBe(true);
      await session.setWebSearchEnabled!(false);
      expect(session.exportCheckpoint().webSearchEnabled).toBe(false);
      expect(session.tools.some(tool => tool.name === "web_search")).toBe(false);
    } finally { await session.cleanup(); }
  });
  it("copies the policy into delegated agents", async () => {
    let childConfig: Record<string, unknown> | undefined;
    vi.spyOn(ToolExecutor.prototype as never, "loadSubagentDeps" as never).mockResolvedValue({ runNativeAgentLoop: async (options: { config: Record<string, unknown> }) => { childConfig = options.config; return { findings: [], turnCount: 1, summary: "Done", done: true }; } } as never);
    const executor = new ToolExecutor(context(false), null, undefined, async () => runtime([end()]));
    try {
      await executor.execute({ name: "spawn_agent", arguments: { task: "Read the current code", max_turns: 1 } });
      expect(childConfig?.webSearchEnabled).toBe(false);
    } finally { await executor.cleanup(); }
  });
});
