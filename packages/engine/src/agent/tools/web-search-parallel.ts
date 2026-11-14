import { readWebSearchResponse, type WebSearchResult } from "./web-search-response.js";

// Anonymous web_search is documented at https://docs.parallel.ai/integrations/mcp/quickstart.
// No API keys, model credentials, paid tools, or discovered remote tools are used.
export const PARALLEL_SEARCH_ENDPOINT = "https://mcp.parallel.ai/mcp";
const PROTOCOL = "2025-03-26";
type SearchResult = { ok: true; results: WebSearchResult[] } | { ok: false; error: string };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function envelopeResult(message: unknown, id: number): Record<string, unknown> | undefined {
  const envelope = object(message);
  if (envelope?.id !== id) return undefined;
  if (envelope.jsonrpc !== "2.0") throw new Error("Parallel search returned an invalid protocol envelope.");
  if (envelope.error !== undefined) throw new Error("Parallel search returned a protocol error.");
  const result = object(envelope.result);
  if (!result) throw new Error("Parallel search returned an invalid result.");
  return result;
}

/** POST SSE streams may stay open after replying: stop at our response ID. */
async function readRpcResponse(response: Response, signal: AbortSignal, id: number): Promise<Record<string, unknown>> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const result = envelopeResult(JSON.parse(await readWebSearchResponse(response, signal)), id);
    if (result) return result;
  } else if (type.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "", bytes = 0;
    const consume = (): Record<string, unknown> | undefined => {
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const result = envelopeResult(JSON.parse(data), id);
        if (result) return result;
      }
      return undefined;
    };
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => { void reader.cancel().catch(() => {}); reject(signal.reason ?? new Error("Search cancelled.")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), cancelled]);
        signal.throwIfAborted();
        if (chunk.done) { pending += decoder.decode() + "\n\n"; const result = consume(); if (result) return result; break; }
        bytes += chunk.value.byteLength;
        if (bytes > 1_000_000) throw new Error("Search response exceeds the size limit.");
        pending += decoder.decode(chunk.value, { stream: true });
        const result = consume();
        if (result) return result;
      }
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    void response.body?.cancel().catch(() => {});
    throw new Error("Parallel search returned an unsupported response type.");
  }
  throw new Error("Parallel search returned no matching response.");
}

function normalize(result: Record<string, unknown>): SearchResult {
  if (result.isError === true) return { ok: false, error: "Parallel search tool returned an error." };
  const payloads: unknown[] = [result.structuredContent];
  if (Array.isArray(result.content)) for (const part of result.content) {
    const block = object(part);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try { payloads.push(JSON.parse(block.text)); } catch { /* Text is not a structured search result. */ }
  }
  const payload = payloads.map(object).find(value => Array.isArray(value?.results));
  if (!payload) return { ok: false, error: "Parallel search returned an unrecognized result shape." };
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.results as unknown[]) {
    const source = object(item);
    if (typeof source?.url !== "string" || source.url.length > 4096 || /[\u0000-\u0020\u007f]/.test(source.url)) continue;
    let url: URL;
    try { url = new URL(source.url); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 4096) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const excerpts = Array.isArray(source.excerpts) ? source.excerpts.filter((value): value is string => typeof value === "string") : [];
    results.push({ title: ((typeof source.title === "string" ? source.title.trim() : "") || url.href).slice(0, 300),
      url: url.href, snippet: excerpts.join(" ").replace(/\s+/g, " ").trim().slice(0, 1000) });
    if (results.length === 5) break;
  }
  if (!results.length && (payload.results as unknown[]).length) return { ok: false, error: "Parallel search returned no usable source URLs." };
  return { ok: true, results };
}

/** A short-lived, search-only MCP session. The caller supplies the scoped,
 * authority-checked, rate-limited transport and the entire operation deadline.
 */
export async function searchParallel(query: string, options: { signal: AbortSignal; fetchImpl: typeof fetch }): Promise<SearchResult> {
  const { signal, fetchImpl } = options;
  let session: string | undefined;
  const request = async (method: string, params: Record<string, unknown>, id?: number): Promise<Record<string, unknown>> => {
    signal.throwIfAborted();
    const response = await fetchImpl(PARALLEL_SEARCH_ENDPOINT, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL,
        ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Parallel search request failed (HTTP ${response.status}).`);
    }
    if (method === "initialize") {
      const assigned = response.headers.get("mcp-session-id");
      if (assigned && (assigned.length > 1000 || /[^\x21-\x7e]/.test(assigned))) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Parallel search returned an invalid session header.");
      }
      session = assigned ?? undefined;
    }
    if (id === undefined) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); return {}; }
    return readRpcResponse(response, signal, id);
  };
  try {
    const initialized = await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "0-web-search", version: "1" } }, 1);
    if (initialized.protocolVersion !== PROTOCOL) throw new Error("Parallel search negotiated an unsupported protocol version.");
    await request("notifications/initialized", {});
    const result = await request("tools/call", { name: "web_search", arguments: { objective: query, search_queries: [query] } }, 2);
    signal.throwIfAborted();
    return normalize(result);
  } catch (error) {
    signal.throwIfAborted();
    return { ok: false, error: error instanceof SyntaxError ? "Parallel search returned malformed JSON." : error instanceof Error ? error.message : "Parallel search failed." };
  }
}
