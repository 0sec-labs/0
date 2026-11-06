import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { LlmApiRuntime, shouldRetryNativeStream } from "./llm-api.js";
import { isTransientLlmError } from "../agent/native-loop.js";

const socketMessage = "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
function runtime(env: Record<string, string> = {}, timeout = 5000) {
  return new LlmApiRuntime({ type: "api", provider: "openrouter", model: "z-ai/glm-5.3-flash", timeout,
    env: { OPENROUTER_API_KEY: "synthetic-not-a-secret", OPENROUTER_WIRE_API: "chat_completions",
      ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "", ...env } });
}
const complete = () => new Response(JSON.stringify({ choices: [{ message: { content: "Finished" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
const run = (rt = runtime(), signal?: AbortSignal) => rt.executeNative("Synthetic transport test", [], [], undefined, signal);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("inference transport retry safety", () => {
  it.each([
    ["Bun socket message", () => new TypeError(socketMessage), "CONNECTION_CLOSED"],
    ["Bun top-level code", () => Object.assign(new TypeError(socketMessage), { code: "ConnectionClosed" }), "CONNECTION_CLOSED"],
    ["top-level reset", () => Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }), "ECONNRESET"],
    ["Bun reset code", () => Object.assign(new TypeError(socketMessage), { code: "ECONNRESET" }), "ECONNRESET"],
    ["nested reset", () => new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }), "ECONNRESET"],
    ["Undici socket", () => new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET", socket: { bytesWritten: 100 } } }), "UND_ERR_SOCKET"],
    ["unattributed timeout", () => Object.assign(new TypeError("fetch failed"), { code: "ETIMEDOUT" }), "ETIMEDOUT"],
  ] as const)("does not replay an ambiguous %s POST", async (_name, error, code) => {
    const fetch = vi.fn().mockRejectedValue(error()); vi.stubGlobal("fetch", fetch);
    const result = await run();
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain(`[${code}]`);
    expect(result.error).toContain("outcome may be unknown");
    expect(result.error).toContain("Automatic replay is disabled");
    expect(result.error).not.toContain("verbose: true");
    expect(result.usage).toBeUndefined();
    expect(shouldRetryNativeStream(result)).toBe(false);
    expect(isTransientLlmError(result.error!)).toBe(false);
  });

  it.each([
    ["top-level DNS", () => Object.assign(new TypeError("DNS unavailable"), { code: "EAI_AGAIN" })],
    ["nested connect timeout", () => new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })],
    ["generic wrapper", () => Object.assign(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }), { code: "ERR_NETWORK" })],
    ["connect syscall timeout", () => Object.assign(new TypeError("connect failed"), { code: "ETIMEDOUT", syscall: "connect" })],
    ["zero bytes written", () => new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET", socket: { bytesWritten: 0 } } })],
  ] as const)("retries a proven pre-dispatch %s failure within the configured bound", async (_name, error) => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubEnv("ZERO_LLM_MAX_RETRIES", "1"); vi.stubEnv("ZERO_LLM_MAX_RETRY_WAIT_MS", "500");
    const fetch = vi.fn().mockRejectedValueOnce(error()).mockResolvedValueOnce(complete()); vi.stubGlobal("fetch", fetch);
    const pending = run(); await vi.advanceTimersByTimeAsync(500);
    expect((await pending).stopReason).toBe("end_turn");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not treat a remote transport error code as proof that inference was not dispatched", async () => {
    vi.useFakeTimers(); vi.stubEnv("ZERO_LLM_MAX_RETRIES", "1");
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("remote connection failed"), { code: "EAI_AGAIN" }));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const rt = new LlmApiRuntime({ type: "api", provider: "chatgpt-codex", model: "gpt-6.1-sol", timeout: 1000,
      providerTransport: { provider: "chatgpt-codex", models: ["gpt-6.1-sol"], identity: "synthetic-transport", request } });
    const pending = run(rt); await vi.advanceTimersByTimeAsync(500);
    expect((await pending).error).toContain("Automatic replay is disabled");
    expect(request).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains strict retry-receipt policy even for a pre-dispatch error", async () => {
    const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("DNS unavailable"), { code: "EAI_AGAIN" }));
    vi.stubGlobal("fetch", fetch);
    const result = await run(runtime({ ZERO_REQUIRE_RETRY_SAFE_RECEIPT: "1" }));
    expect(result.error).toContain("Automatic replay is disabled");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not bypass exhausted pre-dispatch backoff limits", async () => {
    vi.stubEnv("ZERO_LLM_MAX_RETRIES", "0");
    const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" }));
    vi.stubGlobal("fetch", fetch);
    const result = await run();
    expect(result.error).toContain("before inference dispatch [ENOTFOUND]");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels before another connection attempt after pre-dispatch backoff", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
    const controller = new AbortController();
    const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("DNS unavailable"), { code: "EAI_AGAIN" }));
    vi.stubGlobal("fetch", fetch);
    const pending = run(runtime(), controller.signal);
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await vi.advanceTimersByTimeAsync(500);
    expect((await pending).cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves unknown outcome authority when the runtime deadline fires", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new TypeError(socketMessage)), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const pending = run(runtime({}, 20)); await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("Automatic replay is disabled");
    expect(isTransientLlmError(result.error!)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never retries a socket failure while consuming an already accepted response", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError(socketMessage)); } }));
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    const result = await run();
    expect(result.error).toContain("[CONNECTION_CLOSED]");
    expect(result.error).toContain("Automatic replay is disabled");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not duplicate a real POST whose socket closes after the server receives its body", async () => {
    let received = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => { received++; response.destroy(); });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP test server");
    const nativeFetch = globalThis.fetch;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => nativeFetch(`http://127.0.0.1:${address.port}/inference`, init));
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await run();
      expect(received).toBe(1);
      expect(fetch).toHaveBeenCalledOnce();
      expect(result.error).toContain("Automatic replay is disabled");
      expect(isTransientLlmError(result.error!)).toBe(false);
      expect(result.usage).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("does not let a transient stream phrase override an unknown-outcome decision", () => {
    expect(shouldRetryNativeStream({ content: [], stopReason: "error", durationMs: 0,
      error: "response stream failed; request outcome may be unknown. Automatic replay is disabled" })).toBe(false);
  });
});

describe("Bun OpenRouter connection reuse", () => {
  it("uses a fresh connection without enabling verbose header logging or replay", async () => {
    vi.stubGlobal("Bun", { version: "synthetic" });
    const fetch = vi.fn().mockResolvedValue(complete()); vi.stubGlobal("fetch", fetch);
    expect((await run()).stopReason).toBe("end_turn");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toMatchObject({ keepalive: false });
    expect(fetch.mock.calls[0][1]).not.toHaveProperty("verbose");
  });
  it("preserves the default transport options under Node", async () => {
    vi.stubGlobal("Bun", undefined);
    const fetch = vi.fn().mockResolvedValue(complete()); vi.stubGlobal("fetch", fetch);
    expect((await run()).stopReason).toBe("end_turn");
    expect(fetch.mock.calls[0][1]).not.toHaveProperty("keepalive");
  });
});
