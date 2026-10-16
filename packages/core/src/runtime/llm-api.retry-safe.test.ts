import { afterEach, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";
import type { NativeRuntimeResult } from "./types.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function runtime(required = true) {
  return new LlmApiRuntime({ type: "api", provider: "openai", model: "gpt-test", timeout: 1000,
    env: { OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: "http://127.0.0.1:3001/api/inference/v1",
      ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_REQUIRE_RETRY_SAFE_RECEIPT: required ? "1" : "0" } });
}
function post(rt: LlmApiRuntime) {
  return (rt as unknown as { postWithRetry(body: () => string, signal: AbortSignal): Promise<Response> })
    .postWithRetry(() => JSON.stringify({ model: "auto", input: "Fixture" }), new AbortController().signal);
}

it("does not resend unacknowledged 502 or transport failures", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("discarded provider body", { status: 502 }));
  vi.stubGlobal("fetch", fetch);
  await expect(post(runtime())).rejects.toThrow("Automatic replay is disabled"); expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockReset().mockRejectedValue(new Error("reset", { cause: { code: "ECONNRESET" } }));
  await expect(post(runtime())).rejects.toThrow("outcome may be unknown"); expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps success unchanged and leaves ordinary provider policy opt-in", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 })); vi.stubGlobal("fetch", fetch);
  expect((await post(runtime())).status).toBe(200);
  vi.stubEnv("ZERO_LLM_MAX_RETRIES", "0");
  fetch.mockResolvedValue(new Response("failed", { status: 502 }));
  expect((await post(runtime(false))).status).toBe(502);
});

it("permits only an explicitly acknowledged safe retry and preserves its body", async () => {
  vi.stubEnv("ZERO_LLM_429_MAX_RETRIES", "0"); vi.stubEnv("ZERO_LLM_MAX_RETRIES", "0");
  const fetch = vi.fn().mockResolvedValue(new Response('{"error":{"code":"provider_rejected_request"}}', {
    status: 429, headers: { "x-0-retry-safe": "1" },
  })); vi.stubGlobal("fetch", fetch);
  const response = await post(runtime()); expect(response.status).toBe(429);
  expect(await response.text()).toContain("provider_rejected_request"); expect(fetch).toHaveBeenCalledTimes(1);
});

it("stops the separate empty-stream retry loop without dispatching another attempt", async () => {
  const rt = runtime(); const attempt = vi.fn().mockResolvedValue({ content: [], stopReason: "error", durationMs: 1,
    error: "stream completed without final response" } satisfies NativeRuntimeResult);
  (rt as unknown as { executeNativeAttempt: unknown }).executeNativeAttempt = attempt;
  const result = await rt.executeNative("Fixture", [], []);
  expect(attempt).toHaveBeenCalledTimes(1); expect(result.error).toContain("Automatic replay is disabled");
});
