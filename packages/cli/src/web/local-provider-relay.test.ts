import { BackendConnectionError } from "./backend-connections.js";
import { describe, expect, it, test, vi } from "vitest";
import type { ConsoleRuntimeSnapshot } from "@0/shared";
import { createLocalProviderRelay, providerSseCompletion, safeRelayFailure, type LocalRelayProvider } from "./local-provider-relay.js";

function fixture() {
  const envelope = { requestId: "request-1", grantId: "grant-1", epoch: "epoch-1", sessionId: "chat-1", provider: "chatgpt-codex", model: "granted", body: '{"model":"granted"}' };
  const grant = { id: "grant-1", epoch: "epoch-1", provider: "chatgpt-codex", models: ["granted"], model: "granted", expiresAt: new Date(Date.now() + 60000).toISOString() };
  const batch: { grantId: string; epoch: string; sessionId: string; requests: unknown[]; cancelled: string[] } = { grantId: grant.id, epoch: grant.epoch, sessionId: "chat-1", requests: [], cancelled: [] };
  const provider: LocalRelayProvider = {
    info: { providerId: "chatgpt-codex", model: "granted" } as ConsoleRuntimeSnapshot,
    grant: { protocol: 1, provider: "chatgpt-codex", models: ["granted"], limits: { maxRequests: 16, maxConcurrent: 4, timeoutMs: 1000, maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024, maxTotalResponseBytes: 16 * 1024 * 1024 } },
    transport: { provider: "chatgpt-codex", models: ["granted"], request: vi.fn(async () => new Response("data: completed\n\n", { headers: { "Content-Type": "text/event-stream" } })), close: vi.fn(async () => {}) },
  };
  const events: unknown[] = [];
  const registry = { handshake: vi.fn(async () => ({ backend: { status: "connected" }, handshake: { serverInstanceId: "epoch-1" } })), request: vi.fn(async (_backend: string, path: string, options: { method: string; body?: unknown; signal: AbortSignal }) => {
    if (path === "/api/console/provider-relays") return Response.json({ grant });
    if (options.method === "GET") { const result = structuredClone(batch); batch.requests = []; batch.cancelled = []; return Response.json(result); }
    if (path.endsWith("/events")) events.push(options.body);
    return Response.json({ ok: true });
  }) };
  const createProvider = vi.fn(async () => provider);
  const onError = vi.fn();
  return { envelope, grant, batch, provider, events, registry, createProvider, onError, options: { registry, backendId: "remote", createProvider, onError } };
}

describe("local inference relay", () => {
  it.each(["timeout", "host-503"])("recovers a transient %s poll failure without revoking the grant or account", async failure => {
    const f = fixture(); const original = f.registry.request.getMockImplementation()!;
    let rejected = false;
    f.registry.request.mockImplementation(async (backend, path, options) => {
      if (options.method === "GET" && !rejected) {
        rejected = true;
        if (failure === "timeout") throw new BackendConnectionError("Backend request timed out.", 504);
        return new Response("temporarily unavailable", { status: 503 });
      }
      return original(backend, path, options);
    });
    f.batch.requests = [f.envelope];
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    try {
      await vi.waitFor(() => expect(relay.status().phase).toBe("reconnecting"));
      expect(relay.status()).toMatchObject({ lastFailureStage: "poll", lastFailureTransportStatus: failure === "timeout" ? 504 : 503 });
      await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"kind":"end"'), { timeout: 3000 });
      expect(relay.status()).toMatchObject({ phase: "polling", consecutivePollFailures: 0, seenRequests: 1, lastUpstreamStatus: 200 });
      expect(relay.status().error).toBeUndefined();
      expect(f.onError).not.toHaveBeenCalled();
      expect(f.provider.transport.close).not.toHaveBeenCalled();
      expect(f.createProvider).toHaveBeenCalledOnce();
    } finally { await relay.close(); }
  });

  it.each([401, 403, 410])("does not retry a terminal poll HTTP %s failure", async status => {
    const f = fixture(); const original = f.registry.request.getMockImplementation()!;
    f.registry.request.mockImplementation(async (backend, path, options) => options.method === "GET" ? new Response("rejected", { status }) : original(backend, path, options));
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    try {
      await vi.waitFor(() => expect(relay.status().phase).toBe("failed"));
      expect(f.onError).toHaveBeenCalledOnce();
      expect(f.registry.request.mock.calls.filter(([, , options]) => options.method === "GET")).toHaveLength(1);
    } finally { await relay.close(); }
  });

  it("registers only approved model metadata and waits for an explicit session bind", async () => {
    const f = fixture();
    const relay = await createLocalProviderRelay(f.options);
    expect(f.registry.request).toHaveBeenCalledWith("remote", "/api/console/provider-relays", expect.objectContaining({ body: { epoch: "epoch-1", provider: "chatgpt-codex", models: ["granted"], model: "granted" } }));
    expect(f.provider.transport.request).not.toHaveBeenCalled();
    expect(relay.status()).toMatchObject({ phase: "registered", lastPollAt: null, seenRequests: 0, activeRequests: 0, bytesForwarded: 0 });
    relay.start("chat-1");
    expect(() => relay.start("other-chat")).toThrow(/bind once/);
    await relay.close();
    expect(f.registry.request).toHaveBeenLastCalledWith("remote", "/api/console/provider-relays/grant-1", expect.objectContaining({ method: "DELETE" }));
  });
  it("streams approved inference responses in bounded base64 events without forwarding headers or credentials", async () => {
    const f = fixture(); const output = "x".repeat(100_000);
    vi.mocked(f.provider.transport.request).mockResolvedValue(new Response(output, { status: 200, headers: { "Content-Type": "text/event-stream", Authorization: "never-forward-this" } }));
    f.batch.requests = [f.envelope];
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"kind":"end"'));
    const events = f.events.flatMap(body => (body as { events: Array<Record<string, unknown>> }).events);
    const chunks = events.filter(event => event.kind === "chunk").map(event => Buffer.from(event.data as string, "base64"));
    expect(chunks.every(chunk => chunk.byteLength <= 32768)).toBe(true);
    expect(Buffer.concat(chunks).toString()).toBe(output);
    expect(JSON.stringify(f.events)).not.toContain("never-forward-this");
    expect(f.provider.transport.request).toHaveBeenCalledWith({ provider: "chatgpt-codex", model: "granted", body: f.envelope.body }, expect.any(AbortSignal));
    await relay.close();
  });
  it.each(["session", "epoch", "model"])("fails closed for mismatched %s before local inference", async mismatch => {
    const f = fixture(); f.batch.requests = [{ ...f.envelope, ...(mismatch === "session" ? { sessionId: "other-chat" } : mismatch === "epoch" ? { epoch: "other-epoch" } : { model: "unapproved" }) }];
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    await vi.waitFor(() => expect(f.onError).toHaveBeenCalledOnce());
    expect(f.provider.transport.request).not.toHaveBeenCalled();
    await relay.close();
  });
  it("propagates remote cancellation to an open local response and releases it", async () => {
    const f = fixture(); let upstreamSignal: AbortSignal | undefined; const cancel = vi.fn();
    vi.mocked(f.provider.transport.request).mockImplementation(async (_request, signal) => { upstreamSignal = signal; return new Response(new ReadableStream({ cancel })); });
    f.batch.requests = [f.envelope];
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"kind":"headers"'));
    f.batch.cancelled = [f.envelope.requestId];
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    await relay.close();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not leak local provider exception text to the remote engine", async () => {
    const f = fixture(); f.batch.requests = [f.envelope];
    vi.mocked(f.provider.transport.request).mockRejectedValue(new Error("sensitive-local-token /Users/private"));
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"kind":"error"'));
    expect(JSON.stringify(f.events)).not.toMatch(/sensitive-local-token|Users\/private/);
    await relay.close();
  });
  it("ends a semantically completed Responses stream even when the upstream HTTP body stays open", async () => {
    const f = fixture(); const cancel = vi.fn();
    const chunks = ["event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"RELAY_OK\"}\r\n\r\n", "event: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n"];
    vi.mocked(f.provider.transport.request).mockResolvedValue(new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); /* The provider intentionally never closes the socket. */ }, cancel }), { headers: { "Content-Type": "text/event-stream" } }));
    f.batch.requests = [f.envelope];
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"kind":"end"'));
    const forwarded = f.events.flatMap(body => (body as { events: Array<Record<string, unknown>> }).events).filter(event => event.kind === "chunk").map(event => Buffer.from(event.data as string, "base64").toString()).join("");
    expect(forwarded).toBe(chunks.join(""));
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
    expect(relay.status()).toMatchObject({ seenRequests: 1, activeRequests: 0, lastUpstreamStatus: 200, bytesForwarded: Buffer.byteLength(chunks.join("")) });
    await relay.close();
  });

  it.each([200, 413])("records safe chunk-ack failure details even when the error acknowledgment later returns 200 (failed status %s)", async failedStatus => {
    const f = fixture();
    const original = f.registry.request.getMockImplementation()!;
    f.registry.request.mockImplementation(async (backend, path, options) => {
      const event = (options.body as { events?: Array<{ kind: string }> } | undefined)?.events?.[0];
      if (path.endsWith("/events") && event?.kind === "chunk") return new Response(failedStatus === 200 ? "truncated JSON" : "rejected", { status: failedStatus });
      return original(backend, path, options);
    });
    f.batch.requests = [f.envelope];
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"kind":"error"'));
    expect(relay.status()).toMatchObject({ error: "response_rejected", lastFailureStage: "chunk_post", lastFailureName: "RelayResponseError", lastFailureCode: failedStatus === 200 ? "remote_invalid_json" : "remote_http_rejected", lastFailureTransportStatus: failedStatus, bytesForwarded: 0 });
    await relay.close();
  });

  it("preserves a primary poll failure when aborting its still-open upstream reader", async () => {
    const f = fixture(); f.batch.requests = [f.envelope];
    vi.mocked(f.provider.transport.request).mockResolvedValue(new Response(new ReadableStream({}), { headers: { "Content-Type": "text/event-stream" } }));
    const relay = await createLocalProviderRelay(f.options); relay.start("chat-1");
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"kind":"headers"'));
    f.registry.request.mockResolvedValueOnce(new Response("invalid JSON", { status: 200 }));
    await vi.waitFor(() => expect(relay.status().phase).toBe("failed"));
    expect(relay.status()).toMatchObject({ error: "poll_rejected", lastFailureStage: "poll", lastFailureName: "RelayResponseError", lastFailureCode: "remote_invalid_json", lastFailureTransportStatus: 200 });
    await relay.close();
  });

});


describe("provider semantic SSE completion", () => {
  it("handles split UTF-8/CRLF boundaries and ignores text that merely mentions a terminal event", () => {
    const completed = providerSseCompletion();
    expect(completed(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"response.completed 🦆"}\r\n\r\n'))).toBe(false);
    expect(completed(new TextEncoder().encode('data: {"type":"response.output_text.done"}\n\n'))).toBe(false);
    const terminal = new TextEncoder().encode('event: response.completed\r\ndata: {"type":\r\ndata: "response.completed"}\r\n\r\n');
    for (let offset = 0; offset < terminal.length - 1; offset++) expect(completed(terminal.subarray(offset, offset + 1))).toBe(false);
    expect(completed(terminal.subarray(terminal.length - 1))).toBe(true);
  });
  it.each(["response.failed", "response.incomplete", "error"])("recognizes terminal failure %s without synthesizing successful model output", type => {
    expect(providerSseCompletion()(new TextEncoder().encode(`data: ${JSON.stringify({ type })}\n\n`))).toBe(true);
  });
  it("recognizes the DONE sentinel and bounds unterminated event memory", () => {
    expect(providerSseCompletion()(new TextEncoder().encode('data: [DONE]\n\n'))).toBe(true);
    expect(() => providerSseCompletion(8)(new TextEncoder().encode('data: too much data'))).toThrow(/limit/);
    expect(() => providerSseCompletion(8)(new TextEncoder().encode('data: too much data\n\n'))).toThrow(/limit/);
  });
});


test("failure metadata exports only whitelisted names and exact local error categories", () => {
  const error = new Error("sensitive /Users/private token"); error.name = "secret-provider-name";
  expect(safeRelayFailure(error)).toEqual({ name: "OtherError", code: "unclassified" });
  expect(safeRelayFailure(new Error("Provider response stream failed"))).toEqual({ name: "Error", code: "provider_stream_failed" });
  expect(safeRelayFailure(new Error("__proto__"))).toEqual({ name: "Error", code: "unclassified" });
});
