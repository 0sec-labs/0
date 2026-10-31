import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ parallel: vi.fn(), http: vi.fn() }));
vi.mock("./web-search-parallel.js", () => ({ searchParallel: mocks.parallel }));
vi.mock("../../http.js", async original => ({ ...await original<object>(), fetchScoped: mocks.http }));
import { ToolExecutor } from "../tools.js";
import type { ToolContext } from "../types.js";
const context = (): ToolContext => ({ target: "https://target.test", scanId: "search-failover", findings: [], attackResults: [], targetInfo: {}, autonomyMode: "yolo", webSearchEnabled: true, authConfig: { type: "bearer", token: "target-secret" } });
const query = { name: "web_search", arguments: { query: "TypeScript official documentation" } };
const html = '<a href="https://typescript.test/docs" class="result__a">Docs</a>';
beforeEach(() => { mocks.parallel.mockReset().mockResolvedValue({ ok: false, error: "Primary unavailable" }); mocks.http.mockReset().mockImplementation(async () => new Response(html)); });
afterEach(() => { vi.useRealTimers(); });
describe("one search tool with bounded provider failover", () => {
  it("uses anonymous primary results through scoped/rate-limited transport without target credentials", async () => {
    const acquire = vi.fn(async () => {}); const noteResponse = vi.fn();
    const ctx = context(); ctx.rateLimiter = { acquire, noteResponse } as unknown as ToolContext["rateLimiter"];
    mocks.parallel.mockImplementation(async (_query, options) => {
      await options.fetchImpl("https://mcp.parallel.ai/mcp", { method: "POST", body: "{}" });
      return { ok: true, results: [{ title: "Docs", url: "https://typescript.test/", snippet: "Official reference" }] };
    });
    const executor = new ToolExecutor(ctx);
    try {
      const result = await executor.execute(query);
      expect(result).toMatchObject({ success: true, output: { provider: "Parallel" }, meta: { provider: "Parallel" } });
      expect(mocks.http).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledWith("https://mcp.parallel.ai/mcp", 1, expect.any(AbortSignal));
      expect(noteResponse).toHaveBeenCalledOnce();
      expect(new Headers(mocks.http.mock.calls[0]![1].headers).get("authorization")).toBeNull();
      expect(JSON.stringify(mocks.http.mock.calls)).not.toContain("target-secret");
      expect(ctx.target).toBe("https://target.test");
    } finally { await executor.cleanup(); }
  });
  it("falls back after the primary deadline but does not mask a DDG challenge as empty results", async () => {
    mocks.parallel.mockRejectedValue(new DOMException("Primary deadline", "TimeoutError"));
    mocks.http.mockResolvedValue(new Response('<form id="challenge-form">Challenge</form>', { status: 202 }));
    const executor = new ToolExecutor(context());
    try {
      const result = await executor.execute(query);
      expect(result.success).toBe(false); expect(result.error).toContain("verification challenge");
      expect(mocks.http).toHaveBeenCalledOnce();
      expect(String(mocks.http.mock.calls[0]![0])).toContain("html.duckduckgo.com");
    } finally { await executor.cleanup(); }
  });
  it("reports the real fallback provider when it succeeds", async () => {
    const executor = new ToolExecutor(context());
    try { expect(await executor.execute(query)).toMatchObject({ success: true, output: { provider: "DuckDuckGo", results: [{ title: "Docs" }] }, meta: { provider: "DuckDuckGo" } }); }
    finally { await executor.cleanup(); }
  });
  it("does not fall back after parent cancellation", async () => {
    const controller = new AbortController();
    mocks.parallel.mockImplementation(async () => { controller.abort(); throw new DOMException("Cancelled", "AbortError"); });
    const executor = new ToolExecutor(context());
    try { expect((await executor.execute(query, { signal: controller.signal })).success).toBe(false); expect(mocks.http).not.toHaveBeenCalled(); }
    finally { await executor.cleanup(); }
  });
  it("keeps the overall deadline through a stalled fallback response body", async () => {
    vi.useFakeTimers();
    mocks.http.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({})));
    const executor = new ToolExecutor(context());
    try {
      const pending = executor.execute(query);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await pending).success).toBe(false);
    } finally { await executor.cleanup(); }
  });
});
