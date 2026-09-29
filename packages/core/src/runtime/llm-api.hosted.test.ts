import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { LlmApiRuntime, __resetFallbackChainForTests } from "./llm-api.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetFallbackChainForTests();
});

function hostedRuntime(model: string, provider = "hosted") {
  vi.stubEnv("ZERO_FORCE_PROVIDER", provider);
  vi.stubEnv("ZERO_SELECTED_PROVIDER", "");
  vi.stubEnv("ZERO_CLOUD_HOST", "http://127.0.0.1:12345");
  vi.stubEnv("ZERO_CLOUD_TOKEN", "fixture-token");
  vi.stubEnv("ZERO_SKIP_PROVIDER_BANNER", "1");
  return new LlmApiRuntime({ type: "api", model, timeout: 1000 });
}

describe("hosted catalog selection", () => {
  it("distinguishes account admission from model discovery and refreshes it explicitly", async () => {
    const runtime = hostedRuntime("");
    let eligible = false;
    let catalogCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/account")) return Response.json({
        schemaVersion: "usage-v2",
        snapshotAt: "2026-09-22T12:00:00.000Z",
        scope: { orgId: "org_fixture" },
        state: "ready",
        reason: null,
        plan: { id: null, name: null, monthlyPriceUsd: null },
        included: { state: "exhausted", usedPercent: 100, resetsAt: null },
        prepaid: { balanceUsd: "20.00", fallbackEnabled: eligible },
        canManageBilling: true,
        admission: { eligible, reason: eligible ? null : "prepaid_disabled" },
      });
      if (!url.endsWith("/models")) throw new Error("Preflight must not send inference");
      catalogCalls++;
      return Response.json({ data: [{ id: "service-default", wire_api: "chat_completions" }] });
    }));
    await expect(runtime.prepare()).rejects.toMatchObject({
      path: "/api/inference/account", code: "prepaid_disabled",
    });
    expect(catalogCalls).toBe(0);
    eligible = true;
    await runtime.prepare();
    expect(runtime.resolvedModel()).toBe("service-default");
    eligible = false;
    await expect(runtime.prepare()).rejects.toMatchObject({ code: "prepaid_disabled" });
    expect(catalogCalls).toBe(1);
  });

  it("selects the service model after an explicit retry of failed discovery", async () => {
    const runtime = hostedRuntime("");
    let available = false;
    let inferenceCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: available
        ? [{ id: "service-default", wire_api: "chat_completions", max_output_tokens: 512 }]
        : [] });
      inferenceCalls++;
      expect(JSON.parse(String(init?.body)).model).toBe("service-default");
      return Response.json({ choices: [{ message: { content: "Ready" }, finish_reason: "stop" }] });
    }));
    await expect(runtime.executeNative("system", [], [])).rejects.toThrow("No hosted models");
    expect(inferenceCalls).toBe(0);
    available = true;
    const result = await runtime.executeNative("system", [], []);
    expect(result.content).toContainEqual({ type: "text", text: "Ready" });
    expect(inferenceCalls).toBe(1);
  });

  it("does not apply a stale hosted catalog after switching providers", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-primary");
    const runtime = hostedRuntime("");
    const catalog = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return catalog.promise;
      expect(JSON.parse(String(init?.body)).model).toBe("operator-choice");
      return Response.json({ choices: [{ message: { content: "New provider" }, finish_reason: "stop" }] });
    }));
    const result = runtime.executeNative("system", [], []);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    runtime.reconfigure({
      provider: "openai", model: "operator-choice",
      env: { ...process.env, ZERO_FORCE_PROVIDER: "openai" },
    });
    catalog.resolve(Response.json({ data: [{ id: "stale-service-model", wire_api: "responses" }] }));
    expect((await result).content).toContainEqual({ type: "text", text: "New provider" });
    expect(runtime.resolvedModel()).toBe("operator-choice");
  });

  it("uses the catalog wire for an explicitly selected model and returns its tool call", async () => {
    const runtime = hostedRuntime("hosted-responses");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "hosted-responses", wire_api: "responses", max_output_tokens: 512 }] });
      if (!url.endsWith("/responses")) throw new Error("The selected model only supports Responses");
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe("hosted-responses");
      if (typeof request.max_output_tokens !== "number" || request.max_output_tokens > 512) return Response.json({ error: "output limit exceeds model capacity" }, { status: 400 });
      const events = [
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_local", name: "read_file", arguments: '{"path":"sample.txt"}' } },
        { type: "response.completed", response: { output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const result = await runtime.executeNative("Use local tools", [{ role: "user", content: [{ type: "text", text: "Read sample.txt" }] }], [{ name: "read_file", description: "Read a local file", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
    expect(result.content).toContainEqual({ type: "tool_use", id: "call_local", name: "read_file", input: { path: "sample.txt" } });
  });

  it("rejects an unavailable selected model before submitting inference", async () => {
    const runtime = hostedRuntime("not-enabled");
    const inference = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "available", wire_api: "chat_completions" }] });
      inference();
      return new Response(null, { status: 500 });
    }));
    await expect(runtime.executeNative("system", [], [])).rejects.toThrow(/unavailable/);
    expect(inference).not.toHaveBeenCalled();
  });

  it("rebuilds native tool requests across hosted fallback models and wire protocols", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-primary");
    vi.stubEnv("ZERO_LLM_FALLBACK", "hosted:hosted-chat,hosted:hosted-responses");
    vi.stubEnv("ZERO_LLM_429_MAX_RETRIES", "0");
    __resetFallbackChainForTests();
    const runtime = hostedRuntime("primary", "openai");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ object: "list", data: [
        { id: "hosted-chat", wire_api: "chat_completions" },
        { id: "hosted-responses", wire_api: "responses" },
      ] });
      const request = JSON.parse(String(init?.body));
      if (request.model === "primary" || request.model === "hosted-chat") {
        return Response.json({ error: { message: "rate limit" } }, { status: 429, headers: { "x-0-retry-safe": "1" } });
      }
      if (!url.endsWith("/responses") || !Array.isArray(request.input) || request.messages) {
        return Response.json({ error: "wrong model protocol" }, { status: 400 });
      }
      const events = [
        { type: "response.output_item.done", item: { type: "function_call", call_id: "fallback-call", name: "read_file", arguments: '{"path":"sample.txt"}' } },
        { type: "response.completed", response: { output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const result = await runtime.executeNative("Use local tools", [{ role: "user", content: [{ type: "text", text: "Read sample.txt" }] }], [{ name: "read_file", description: "Read a local file", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
    expect(result.content).toContainEqual({ type: "tool_use", id: "fallback-call", name: "read_file", input: { path: "sample.txt" } });
  });

  it("rebuilds a plain completion for a hosted Responses fallback", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-primary");
    vi.stubEnv("ZERO_LLM_FALLBACK", "hosted:hosted-responses");
    vi.stubEnv("ZERO_LLM_429_MAX_RETRIES", "0");
    __resetFallbackChainForTests();
    const runtime = hostedRuntime("primary", "openai");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "hosted-responses", wire_api: "responses" }] });
      const request = JSON.parse(String(init?.body));
      if (request.model === "primary") return Response.json({ error: { message: "rate limit" } }, { status: 429 });
      if (!url.endsWith("/responses") || !Array.isArray(request.input) || request.messages) {
        return Response.json({ error: "wrong model protocol" }, { status: 400 });
      }
      return Response.json({ output_text: "fallback answer" });
    }));
    const result = await runtime.execute("Reply to the fixture");
    expect(result).toMatchObject({ exitCode: 0, output: "fallback answer" });
  });

  it("does not replay a hosted request after a dropped response", async () => {
    const runtime = hostedRuntime("hosted-chat");
    let attempts = 0;
    vi.stubEnv("ZERO_LLM_MAX_RETRIES", "3");
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "hosted-chat", wire_api: "chat_completions", max_output_tokens: 512 }] });
      attempts++;
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }));
    await expect(runtime.executeNative("system", [{ role: "user", content: [{ type: "text", text: "fixture" }] }], []))
      .resolves.toMatchObject({ stopReason: "error", retrySafe: false });
    expect(attempts).toBe(1);
  });

  it("does not replay a hosted request after a gateway 502", async () => {
    const runtime = hostedRuntime("hosted-chat");
    let attempts = 0;
    vi.stubEnv("ZERO_LLM_MAX_RETRIES", "3");
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "hosted-chat", wire_api: "chat_completions", max_output_tokens: 512 }] });
      attempts++;
      return new Response("upstream response unavailable", { status: 502 });
    }));
    await expect(runtime.executeNative("system", [{ role: "user", content: [{ type: "text", text: "fixture" }] }], []))
      .resolves.toMatchObject({ stopReason: "error", retrySafe: false });
    expect(attempts).toBe(1);
  });

  it("does not replay a hosted stream that ends without a terminal event", async () => {
    const runtime = hostedRuntime("hosted-responses");
    vi.stubEnv("ZERO_LLM_STREAM_MAX_ATTEMPTS", "3");
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "hosted-responses", wire_api: "responses", max_output_tokens: 512 }] });
      attempts++;
      return new Response("data: {\"type\":\"response.created\"}\n\n", { headers: { "content-type": "text/event-stream" } });
    }));
    const result = await runtime.executeNative("system", [{ role: "user", content: [{ type: "text", text: "fixture" }] }], []);
    expect(result).toMatchObject({ stopReason: "error", error: expect.stringContaining("stream completed without final response") });
    expect(attempts).toBe(1);
  });

  it("does not replay a hosted 429 without proof of pre-dispatch admission", async () => {
    const runtime = hostedRuntime("hosted-chat");
    let attempts = 0;
    vi.stubEnv("ZERO_LLM_429_MAX_RETRIES", "1");
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "hosted-chat", wire_api: "chat_completions", max_output_tokens: 512 }] });
      attempts++;
      return Response.json({ error: { code: "provider_rejected_request" } }, { status: 429, headers: { "retry-after": "0" } });
    }));
    const result = await runtime.executeNative("system", [{ role: "user", content: [{ type: "text", text: "fixture" }] }], []);
    expect(result).toMatchObject({ stopReason: "error", retrySafe: false });
    expect(attempts).toBe(1);
  });

  it("marks only proven pre-dispatch hosted 429s safe for an outer retry", async () => {
    const runtime = hostedRuntime("hosted-chat");
    vi.stubEnv("ZERO_LLM_429_MAX_RETRIES", "0");
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "hosted-chat", wire_api: "chat_completions", max_output_tokens: 512 }] });
      attempts++;
      return Response.json({ error: { code: "rate_limit" } }, { status: 429, headers: { "x-0-retry-safe": "1" } });
    }));
    const result = await runtime.executeNative("system", [{ role: "user", content: [{ type: "text", text: "fixture" }] }], []);
    expect(result).toMatchObject({ stopReason: "error", retrySafe: true });
    expect(attempts).toBe(1);
  });

  it("retains the direct-provider transport retry contract", async () => {
    vi.stubEnv("OPENAI_API_KEY", randomUUID());
    vi.stubEnv("ZERO_LLM_MAX_RETRIES", "1");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const runtime = hostedRuntime("primary", "openai");
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++attempts === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return Response.json({ choices: [{ message: { content: "recovered answer" } }] });
    }));
    await expect(runtime.execute("fixture")).resolves.toMatchObject({ exitCode: 0, output: "recovered answer" });
    expect(attempts).toBe(2);
  });
});

describe("shared hosted request admission", () => {
  it("queues nested workers until response bodies finish instead of generating capacity errors", async () => {
    vi.useFakeTimers();
    const root = hostedRuntime("");
    vi.stubEnv("ZERO_LLM_429_MAX_RETRIES", "0");
    let active = 0;
    let rejected = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "service-default", wire_api: "chat_completions", max_output_tokens: 512 }] });
      if (active >= 4) {
        rejected++;
        return Response.json({ error: { code: "inference_concurrency_limit" } }, { status: 429 });
      }
      active++;
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            active--;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              choices: [{ message: { content: "completed" }, finish_reason: "stop" }],
            })));
            controller.close();
          }, 10);
        },
      }));
    }));
    const child = await root.forkForSubagent(1000);
    const workers = [root, child, ...await Promise.all(Array.from({ length: 12 }, () => child.forkForSubagent(1000)))];
    const pending = Promise.all(workers.map(runtime => runtime.executeNative("system", [], [])));
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(rejected).toBe(0);
    for (const result of results) {
      expect(result.content).toContainEqual({ type: "text", text: "completed" });
    }
  });

  it("cancels queued work without dispatch and shares capacity with plain completions", async () => {
    vi.useFakeTimers();
    const root = hostedRuntime("");
    const held: Array<{ resolve(response: Response): void }> = [];
    const sent: string[] = [];
    let hold = true;
    const answer = () => Response.json({ choices: [{ message: { content: "completed" }, finish_reason: "stop" }] });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "service-default", wire_api: "chat_completions" }] });
      sent.push(String(init?.body));
      if (!hold) return answer();
      const response = Promise.withResolvers<Response>();
      held.push(response);
      return response.promise;
    }));
    const active = Array.from({ length: 4 }, () => root.executeNative("active", [], []));
    await vi.waitFor(() => expect(held).toHaveLength(4));
    const controller = new AbortController();
    const cancelled = root.executeNative("must-not-send", [], [], undefined, controller.signal);
    const legacy = root.execute("plain-completion");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await cancelled).toMatchObject({ cancelled: true, stopReason: "error" });
    expect(sent).toHaveLength(4);
    hold = false;
    for (const response of held) response.resolve(answer());
    await Promise.all(active);
    expect(await legacy).toMatchObject({ output: "completed", exitCode: 0 });
    expect(sent).toHaveLength(5);
    expect(sent.some(body => body.includes("must-not-send"))).toBe(false);
  });

  it("does not queue a different cloud credential behind another account", async () => {
    const root = hostedRuntime("");
    const held: Array<{ resolve(response: Response): void }> = [];
    const answer = () => Response.json({ choices: [{ message: { content: "independent" }, finish_reason: "stop" }] });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "service-default", wire_api: "chat_completions" }] });
      if (new Headers(init?.headers).get("authorization") === "Bearer other-account") return answer();
      const response = Promise.withResolvers<Response>();
      held.push(response);
      return response.promise;
    }));
    const active = Array.from({ length: 4 }, () => root.executeNative("active", [], []));
    await vi.waitFor(() => expect(held).toHaveLength(4));
    const other = new LlmApiRuntime({ type: "api", provider: "hosted", model: "", timeout: 1000,
      env: { ...process.env, ZERO_CLOUD_TOKEN: "other-account" },
    });
    try {
      expect((await other.executeNative("other", [], [])).content).toContainEqual({ type: "text", text: "independent" });
    } finally {
      for (const response of held) response.resolve(answer());
      await Promise.all(active);
    }
  });
});
