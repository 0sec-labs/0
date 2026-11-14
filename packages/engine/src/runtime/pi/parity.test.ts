/**
 * Runtime parity: the same wire-level scenarios run through the `NativeRuntime`
 * contract against BOTH LlmApiRuntime (default) and PiAiRuntime (opt-in). The
 * provider is simulated at the HTTP boundary (stubbed global fetch) so each
 * runtime exercises its real request building, parsing, retry and error paths.
 * The mock answers the Anthropic Messages wire either as JSON (what
 * LlmApiRuntime requests) or SSE (what pi requests), from one abstract reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "../llm-api.js";
import { PiAiRuntime } from "./runtime.js";
import type { NativeMessage, NativeRuntime, NativeToolDef, RuntimeConfig } from "../types.js";

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
interface Reply { content: Block[]; stop_reason: "end_turn" | "tool_use" | "max_tokens"; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
type Step =
  | { reply: Reply }
  | { http: number; headers?: Record<string, string>; body?: unknown }
  | { chat: { text: string } }
  | { throws: Error }
  | { hang: true };
interface Call { url: string; method: string; headers: Headers; body: Record<string, any> | undefined }

const enc = new TextEncoder();
const sse = (events: Array<[string, unknown]>): Response =>
  new Response(enc.encode(events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join("")), { status: 200, headers: { "content-type": "text/event-stream" } });

function anthropicResponse(reply: Reply, stream: boolean): Response {
  if (!stream) return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m", ...reply }), { status: 200, headers: { "content-type": "application/json" } });
  const events: Array<[string, unknown]> = [["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m", usage: { ...reply.usage, output_tokens: 1 } } }]];
  reply.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else if (block.type === "thinking") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: reply.stop_reason }, usage: { output_tokens: reply.usage.output_tokens } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return sse(events);
}

function chatResponse(text: string, stream: boolean): Response {
  if (!stream) return new Response(JSON.stringify({ id: "c1", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  return new Response(enc.encode(chunk({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })
    + chunk({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
    + "data: [DONE]\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function installFetch(steps: Step[]): { calls: Call[]; inference: () => Call[] } {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : undefined;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers as HeadersInit), body });
    if ((init?.method ?? "GET").toUpperCase() === "GET") return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
    const step = steps[Math.min(i++, steps.length - 1)]!;
    const stream = body?.stream === true;
    if ("reply" in step) return anthropicResponse(step.reply, stream);
    if ("chat" in step) return chatResponse(step.chat.text, stream);
    if ("http" in step) return new Response(typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? { type: "error", error: { type: "api_error", message: `http ${step.http}` } }), { status: step.http, headers: { "content-type": "application/json", ...step.headers } });
    if ("throws" in step) throw step.throws;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }));
  return { calls, inference: () => calls.filter((c) => c.method === "POST") };
}
let catalog: unknown = { data: [] };

const ok = (text: string, usage: Reply["usage"] = { input_tokens: 12, output_tokens: 5 }): Step => ({ reply: { content: [{ type: "text", text }], stop_reason: "end_turn", usage } });
const rateLimited: Step = { http: 429, headers: { "retry-after-ms": "0" }, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } };
const user = (text: string): NativeMessage => ({ role: "user", content: [{ type: "text", text }] });
const tool: NativeToolDef = { name: "echo", description: "echo", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

type Kind = "default (LlmApiRuntime)" | "pi-ai (PiAiRuntime)";
function make(kind: Kind, extra: Partial<RuntimeConfig> = {}): NativeRuntime {
  const config: RuntimeConfig = { type: "api", timeout: 5_000, provider: "anthropic", model: "claude-sonnet-4-5", ...extra };
  return kind === "pi-ai (PiAiRuntime)" ? new PiAiRuntime(config) : new LlmApiRuntime(config);
}

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_WIRE_API", "OPENROUTER_API_KEY", "ZERO_MODEL", "ZERO_LLM_FALLBACK", "ZERO_REQUIRE_RETRY_SAFE_RECEIPT",
  "ZERO_REQUIRE_REQUEST_ADMISSION", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_REASONING_EFFORT", "ZERO_LLM_MAX_RETRIES", "ZERO_LLM_429_MAX_RETRIES", "ZERO_RUNTIME"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [...ENV_KEYS, "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"]) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-parity-key-0123456789";
  delete process.env["ANTHROPIC_BASE_URL"];
  process.env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"] = "1";
  catalog = { data: [] };
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe.each<Kind>(["default (LlmApiRuntime)", "pi-ai (PiAiRuntime)"])("NativeRuntime contract parity: %s", (kind) => {
  it("text turn: end_turn, content, usage", async () => {
    installFetch([ok("hello")]);
    const r = await make(kind).executeNative("sys", [user("hi")], []);
    expect(r.stopReason).toBe("end_turn");
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(r.cancelled).toBeUndefined();
    expect(r.timedOut).toBeUndefined();
  });

  it("tool_use turn: stopReason tool_use with parsed input", async () => {
    installFetch([{ reply: { content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "toolu_1", name: "echo", input: { text: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 9, output_tokens: 4 } } }]);
    const r = await make(kind).executeNative("sys", [user("go")], [tool]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([{ type: "text", text: "calling" }, { type: "tool_use", id: "toolu_1", name: "echo", input: { text: "x" } }]);
  });

  it("max_tokens maps to max_tokens", async () => {
    installFetch([{ reply: { content: [{ type: "text", text: "trunc" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } } }]);
    expect((await make(kind).executeNative("", [user("a")], [])).stopReason).toBe("max_tokens");
  });

  it("cache accounting: inputTokens is the TOTAL prompt (uncached + reads + writes)", async () => {
    installFetch([ok("c", { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90, cache_creation_input_tokens: 20 })]);
    const r = await make(kind).executeNative("sys", [user("a")], []);
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 3, cachedInputTokens: 90, cacheWriteTokens: 20 });
  });

  it("onUsage reports the same totals the result carries", async () => {
    installFetch([ok("c", { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 })]);
    const seen: unknown[] = [];
    const r = await make(kind).executeNative("sys", [user("a")], [], { onUsage: (u) => seen.push(u) });
    expect(seen.at(-1)).toEqual(r.usage);
  });

  it("thinking never leaks into content and is surfaced through onThinking", async () => {
    installFetch([{ reply: { content: [{ type: "thinking", thinking: "plan it", signature: "sig" }, { type: "text", text: "answer" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } } }]);
    const thinking: string[] = [];
    const r = await make(kind).executeNative("sys", [user("a")], [], { onThinking: (t) => thinking.push(t) });
    expect(r.content).toEqual([{ type: "text", text: "answer" }]);
    expect(thinking.join("")).toContain("plan it");
  });

  it("history round trip: assistant tool_use and the user tool_result reach the wire paired by id", async () => {
    const f = installFetch([ok("done")]);
    const history: NativeMessage[] = [
      user("go"),
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "echo", input: { text: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "x-result" }] },
    ];
    const r = await make(kind).executeNative("SYS", history, [tool]);
    expect(r.stopReason).toBe("end_turn");
    const body = f.inference()[0]!.body!;
    const wireMessages = body.messages as Array<{ role: string; content: Array<Record<string, any>> | string }>;
    const blocks = wireMessages.flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => ({ role: m.role, ...b })) : []));
    expect(blocks.find((b) => b.type === "tool_use")).toMatchObject({ role: "assistant", id: "toolu_9", name: "echo", input: { text: "x" } });
    expect(blocks.find((b) => b.type === "tool_result")).toMatchObject({ role: "user", tool_use_id: "toolu_9" });
    expect(JSON.stringify(blocks.find((b) => b.type === "tool_result"))).toContain("x-result");
    expect(JSON.stringify(body.system)).toContain("SYS");
    expect((body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["echo"]);
  });

  it("sends the API key header; a 401 is a plain error", async () => {
    const f = installFetch([{ http: 401, body: { type: "error", error: { type: "authentication_error", message: "bad key sk-ant-parity-key-0123456789" } } }]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(f.inference()[0]!.headers.get("x-api-key")).toBe("sk-ant-parity-key-0123456789");
    expect(r.stopReason).toBe("error");
    // Divergence (improvement): only PiAiRuntime redacts a key the provider echoes back in its error body.
    if (kind.startsWith("pi-ai")) expect(r.error).not.toContain("sk-ant-parity-key-0123456789");
    expect(r.error).toContain("401");
    expect(f.inference()).toHaveLength(1);
  });

  it("HTTP 400 fails fast: error stopReason, no retry", async () => {
    const f = installFetch([{ http: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad schema" } } }]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("400");
    expect(f.inference()).toHaveLength(1);
  });

  it("429 is retried (Retry-After honoured) and then succeeds", async () => {
    const f = installFetch([rateLimited, ok("after")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.content).toEqual([{ type: "text", text: "after" }]);
    expect(f.inference()).toHaveLength(2);
  });

  it("503 is retried and then succeeds", async () => {
    const f = installFetch([{ http: 503, headers: { "retry-after": "0" } }, ok("after")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.content).toEqual([{ type: "text", text: "after" }]);
    expect(f.inference()).toHaveLength(2);
  });

  it("429 retry budget exhausted returns an error (ZERO_LLM_429_MAX_RETRIES)", async () => {
    process.env["ZERO_LLM_429_MAX_RETRIES"] = "1";
    const f = installFetch([rateLimited]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("429");
    expect(f.inference()).toHaveLength(2);
  });

  it("plan-quota 429 is never retried and is reported as quota exhausted", async () => {
    const f = installFetch([{ http: 429, body: { error: { type: "usage_limit_reached", plan_type: "pro", resets_in_seconds: 3600 } } }]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("plan quota exhausted");
    expect(f.inference()).toHaveLength(1);
  });

  it("ZERO_LLM_FALLBACK: quota exhaustion fails over to the next provider and re-issues the request", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-fallback-0123456789";
    process.env["OPENAI_WIRE_API"] = "chat_completions";
    process.env["ZERO_LLM_FALLBACK"] = "openai:gpt-4o-mini";
    const f = installFetch([{ http: 429, body: { error: { type: "usage_limit_reached", plan_type: "pro" } } }, { chat: { text: "from-openai" } }]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("end_turn");
    expect(r.content).toEqual([{ type: "text", text: "from-openai" }]);
    const urls = f.inference().map((c) => c.url);
    expect(urls[0]).toContain("anthropic.com");
    expect(urls[1]).toContain("openai.com");
    expect(f.inference()[1]!.body?.model).toBe("gpt-4o-mini");
  });

  it("ZERO_LLM_FALLBACK: 429 retry budget exhaustion also fails over", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-fallback-0123456789";
    process.env["OPENAI_WIRE_API"] = "chat_completions";
    process.env["ZERO_LLM_FALLBACK"] = "openai:gpt-4o-mini";
    process.env["ZERO_LLM_429_MAX_RETRIES"] = "0";
    const f = installFetch([rateLimited, { chat: { text: "from-openai" } }]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.content).toEqual([{ type: "text", text: "from-openai" }]);
    expect(f.inference()).toHaveLength(2);
  });

  it("already-aborted signal: no request, cancelled", async () => {
    const f = installFetch([ok("never")]);
    const c = new AbortController(); c.abort();
    const r = await make(kind).executeNative("", [user("a")], [], undefined, c.signal);
    expect(r.cancelled).toBe(true);
    expect(r.stopReason).toBe("error");
    expect(r.timedOut).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it("operator abort mid-flight is terminal: cancelled, not retried", async () => {
    const f = installFetch([{ hang: true }, ok("must not happen")]);
    const c = new AbortController();
    const p = make(kind).executeNative("", [user("a")], [], undefined, c.signal);
    setTimeout(() => c.abort(), 50);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBeUndefined();
    expect(f.inference()).toHaveLength(1);
  });

  it("operator abort during a 429 backoff is terminal (no further request, no failover)", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-fallback-0123456789";
    process.env["ZERO_LLM_FALLBACK"] = "openai:gpt-4o-mini";
    const f = installFetch([{ http: 429, headers: { "retry-after": "30" }, body: { error: { type: "rate_limit_error" } } }, ok("must not happen")]);
    const c = new AbortController();
    const p = make(kind).executeNative("", [user("a")], [], undefined, c.signal);
    setTimeout(() => c.abort(), 80);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(f.inference()).toHaveLength(1);
  });

  it("own timeout: timedOut, never cancelled", async () => {
    installFetch([{ hang: true }]);
    const r = await make(kind, { timeout: 80 }).executeNative("", [user("a")], []);
    expect(r.timedOut).toBe(true);
    expect(r.cancelled).toBeUndefined();
    expect(r.stopReason).toBe("error");
  });

  it("transport failure with unknown outcome is NEVER replayed", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const f = installFetch([{ throws: reset }, ok("must not happen")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("Automatic replay is disabled");
    expect(f.inference()).toHaveLength(1);
  });

  it("pre-dispatch connect failure is replayed", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const f = installFetch([{ throws: refused }, ok("after")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.content).toEqual([{ type: "text", text: "after" }]);
    expect(f.inference()).toHaveLength(2);
  });

  it("ZERO_REQUIRE_RETRY_SAFE_RECEIPT: a non-2xx without the receipt header is never replayed", async () => {
    process.env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] = "1";
    const f = installFetch([{ http: 503 }, ok("must not happen")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("Automatic replay is disabled");
    expect(f.inference()).toHaveLength(1);
  });

  it("ZERO_REQUIRE_RETRY_SAFE_RECEIPT: a pre-dispatch connect failure is not replayed either", async () => {
    process.env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] = "1";
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const f = installFetch([{ throws: refused }, ok("must not happen")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("Automatic replay is disabled");
    expect(f.inference()).toHaveLength(1);
  });

  it("ZERO_REQUIRE_REQUEST_ADMISSION: an over-limit body is rejected locally before any inference POST", async () => {
    process.env["ZERO_REQUIRE_REQUEST_ADMISSION"] = "1";
    catalog = { data: [{ id: "claude-sonnet-4-5", request_admission: { schema: "0-inference-request-admission-v1", counting: "utf8_json_body_plus_framing", max_body_bytes: 50, max_serialized_input_bytes: null, framing: { base_bytes: 0, per_message_bytes: 0, per_tool_bytes: 0 } } }] };
    const f = installFetch([ok("never")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/^LOCAL_REQUEST_ADMISSION_LIMIT:/);
    expect(f.inference()).toHaveLength(0);
  });

  it("ZERO_REQUIRE_REQUEST_ADMISSION: a missing catalog contract fails closed", async () => {
    process.env["ZERO_REQUIRE_REQUEST_ADMISSION"] = "1";
    const f = installFetch([ok("never")]);
    const r = await make(kind).executeNative("", [user("a")], []);
    expect(r.error).toMatch(/^LOCAL_REQUEST_ADMISSION_UNAVAILABLE:/);
    expect(f.inference()).toHaveLength(0);
  });

  it("identity surface: type, resolvedModel, resolvedProvider, pricing key", () => {
    const rt = make(kind);
    expect(rt.type).toBe("api");
    expect(rt.resolvedModel?.()).toBe("claude-sonnet-4-5");
    expect(rt.resolvedProvider?.()).toBe("anthropic");
    expect(rt.resolvedPricingModel?.()).toBe("anthropic/claude-sonnet-4-5");
    expect(rt.outputTokenLimit).toBe(8192);
  });

  it("forks inherit model and refuse an unapproved model", async () => {
    const rt = make(kind, { agentModels: { scout: "claude-haiku-4-5" } });
    expect((await rt.forkForSubagent!(1_000)).resolvedModel?.()).toBe("claude-sonnet-4-5");
    expect((await rt.forkForSubagent!(1_000, { role: "scout" })).resolvedModel?.()).toBe("claude-haiku-4-5");
    await expect(rt.forkForSubagent!(1_000, { model: "claude-opus-4-5" })).rejects.toThrow(/not operator-approved/);
  });
});
