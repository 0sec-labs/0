import { describe, expect, it, vi } from "vitest";
import { PARALLEL_SEARCH_ENDPOINT, searchParallel } from "./web-search-parallel.js";

const envelope = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const source = (index = 0) => ({ title: `Source ${index}`, url: `https://docs.example.com/${index}`, excerpts: ["First excerpt", "Second excerpt"] });
function transport(result: unknown, sse = false) {
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(PARALLEL_SEARCH_ENDPOINT);
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") {
      expect(request).not.toHaveProperty("id");
      expect(headers.get("mcp-session-id")).toBe("server-assigned-session");
      return new Response(null, { status: 202 });
    }
    const data = request.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} } } : result;
    const value = envelope(request.id, data);
    return sse
      ? new Response(`: keepalive\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\r\n\r\nevent: message\r\ndata: ${JSON.stringify(value)}\r\n\r\n`, { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "server-assigned-session" } })
      : Response.json(value, { headers: { "Mcp-Session-Id": "server-assigned-session" } });
  });
}
const options = (fetchImpl: typeof fetch) => ({ fetchImpl, signal: AbortSignal.timeout(2000) });

describe("anonymous Parallel MCP search", () => {
  it.each([false, true])("initializes an anonymous session and reads bounded sources (SSE=%s)", async sse => {
    const fetchImpl = transport({ structuredContent: { results: Array.from({ length: 8 }, (_, index) => source(index)) } }, sse);
    const result = await searchParallel("TypeScript official handbook", options(fetchImpl));
    expect(result.ok && result.results[0]).toEqual({ title: "Source 0", url: "https://docs.example.com/0", snippet: "First excerpt Second excerpt" });
    if (result.ok) expect(result.results).toHaveLength(5);
    const requests = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.map(request => request.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(requests[2]).toMatchObject({ params: { name: "web_search", arguments: { objective: "TypeScript official handbook", search_queries: ["TypeScript official handbook"] } } });
    expect(requests[2].params.arguments).not.toHaveProperty("session_id");
    expect(requests[2].params.arguments).not.toHaveProperty("client_model");
  });

  it("supports JSON text content and rejects unsafe or duplicate URLs", async () => {
    const fetchImpl = transport({ content: [{ type: "text", text: JSON.stringify({ results: [source(), source(), { ...source(1), url: "javascript:alert(1)" }, { ...source(2), url: "https://user:password@example.com" }, source(3)] }) }] });
    const result = await searchParallel("official docs", options(fetchImpl));
    expect(result.ok && result.results.map(item => item.url)).toEqual(["https://docs.example.com/0", "https://docs.example.com/3"]);
  });

  it("bounds canonical Unicode URLs and fallback titles", async () => {
    const result = await searchParallel("official docs", options(transport({ structuredContent: { results: [
      { title: "", url: `https://docs.example.com/${"é".repeat(1000)}`, excerpts: [] },
      { title: "", url: `https://docs.example.com/${"a".repeat(500)}`, excerpts: [] },
    ] } })));
    expect(result.ok && result.results).toHaveLength(1);
    expect(result.ok && result.results[0]!.title.length).toBe(300);
  });

  it.each([401, 403, 429, 503])("returns an honest HTTP %i failure without exposing upstream text", async status => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("upstream-private-message", { status }));
    const result = await searchParallel("official docs", options(fetchImpl));
    expect(result).toEqual({ ok: false, error: `Parallel search request failed (HTTP ${status}).` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ isError: true, content: [{ type: "text", text: "untrusted server error" }] }, "tool returned an error"],
    [{ structuredContent: { results: "wrong shape" } }, "unrecognized result shape"],
    [{ structuredContent: { results: [{ url: "file:///private/data" }] } }, "no usable source URLs"],
  ])("reports provider errors and malformed results instead of empty success", async (value, error) => {
    const result = await searchParallel("official docs", options(transport(value)));
    expect(result).toEqual({ ok: false, error: expect.stringContaining(error) });
  });

  it("accepts an explicit empty structured result and bounds text fields", async () => {
    expect(await searchParallel("official docs", options(transport({ structuredContent: { results: [] } })))).toEqual({ ok: true, results: [] });
    const result = await searchParallel("official docs", options(transport({ structuredContent: { results: [{ ...source(), title: "t".repeat(1000), excerpts: ["s".repeat(5000)] }] } })));
    expect(result.ok && result.results[0]!.title.length).toBe(300);
    expect(result.ok && result.results[0]!.snippet.length).toBe(1000);
  });

  it.each([
    ['{"jsonrpc":"2.0","id":99,"result":{}}', "no matching response"],
    ['{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"private"}}', "protocol error"],
    ['{"jsonrpc":"1.0","id":1,"result":{}}', "invalid protocol envelope"],
    ["not json", "malformed JSON"],
  ])("rejects invalid protocol envelopes", async (body, error) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { headers: { "Content-Type": "application/json" } }));
    expect(await searchParallel("official docs", options(fetchImpl))).toEqual({ ok: false, error: expect.stringContaining(error) });
  });

  it("keeps cancellation active through a stalled body and cancels the reader", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(new Error("operator cancelled")), 5); }, cancel: cancelled }), { headers: { "Content-Type": "text/event-stream" } }));
    await expect(searchParallel("official docs", { fetchImpl, signal: controller.signal })).rejects.toThrow("operator cancelled");
    expect(cancelled).toHaveBeenCalled();
  });

  it("returns a complete SSE response without waiting for stream close", async () => {
    const closed = vi.fn();
    const standard = transport({ structuredContent: { results: [source()] } });
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method !== "tools/call") return standard(url, init);
      const text = `event: message\ndata: ${JSON.stringify(envelope(2, { structuredContent: { results: [source()] } }))}\n\n`;
      return new Response(new ReadableStream({ start(controller) {
        // Split a protocol frame across chunks and leave the stream open.
        controller.enqueue(new TextEncoder().encode(text.slice(0, 17)));
        controller.enqueue(new TextEncoder().encode(text.slice(17)));
      }, cancel: closed }), { headers: { "Content-Type": "text/event-stream" } });
    });
    const result = await searchParallel("official docs", options(fetchImpl));
    expect(result.ok && result.results).toHaveLength(1);
    expect(closed).toHaveBeenCalled();
  });

  it("does not start a request after cancellation", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(searchParallel("official docs", { fetchImpl, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(" ".repeat(1_000_001), { headers: { "Content-Type": "application/json" } }));
    expect(await searchParallel("official docs", options(fetchImpl))).toEqual({ ok: false, error: expect.stringContaining("size limit") });
  });
});
