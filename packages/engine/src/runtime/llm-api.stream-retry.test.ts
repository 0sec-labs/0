import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LlmApiRuntime,
  shouldRetryNativeStream,
  llmStreamMaxAttempts,
  streamRetryBackoffMs,
} from "./llm-api.js";
import { diag, type DiagnosticEvent } from "../diagnostics/channel.js";
import type { NativeRuntimeResult } from "./types.js";

// A transient empty-stream outcome exactly as consumeResponsesStream shapes it.
function transient(message: string): NativeRuntimeResult {
  return {
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    durationMs: 1,
    error: `ChatGPT (Codex backend) API error: ${message}`,
  };
}

describe("shouldRetryNativeStream (pure retry decision)", () => {
  it("retries a stream that completed without a final response", () => {
    expect(shouldRetryNativeStream(transient("stream completed without final response"))).toBe(true);
  });

  it("retries an OpenRouter response stream failure", () => {
    expect(shouldRetryNativeStream(transient("response stream failed"))).toBe(true);
  });

  it("does NOT retry a 4xx / validation API error", () => {
    expect(
      shouldRetryNativeStream({
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: 1,
        error: "OpenAI API error 400: invalid_request_error: bad tool schema",
      }),
    ).toBe(false);
  });

  it("does NOT retry a timeout or a stall", () => {
    expect(
      shouldRetryNativeStream({
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: 1,
        error: "OpenAI API request timed out",
      }),
    ).toBe(false);
    expect(
      shouldRetryNativeStream({
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: 1,
        error: "OpenAI stream stalled — no SSE events for 60s (server accepted but held the stream; transient)",
      }),
    ).toBe(false);
  });

  it("does NOT retry an operator cancellation, even with a matching message", () => {
    expect(
      shouldRetryNativeStream({
        ...transient("stream completed without final response"),
        cancelled: true,
      }),
    ).toBe(false);
  });

  it("does NOT retry a successful end_turn / tool_use outcome", () => {
    expect(
      shouldRetryNativeStream({
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        durationMs: 1,
      }),
    ).toBe(false);
    expect(
      shouldRetryNativeStream({
        content: [{ type: "tool_use", id: "1", name: "shell", input: {} }],
        stopReason: "tool_use",
        durationMs: 1,
      }),
    ).toBe(false);
  });

  it("does NOT retry when tool calls were already produced, even on an error", () => {
    expect(
      shouldRetryNativeStream({
        content: [{ type: "tool_use", id: "1", name: "shell", input: {} }],
        stopReason: "error",
        durationMs: 1,
        error: "ChatGPT (Codex backend) API error: stream completed without final response",
      }),
    ).toBe(false);
  });
});

describe("stream retry policy knobs", () => {
  const saved = process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"];
  afterEach(() => {
    if (saved === undefined) delete process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"];
    else process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = saved;
  });

  it("defaults to 3 attempts and clamps the env override to [1,5]", () => {
    delete process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"];
    expect(llmStreamMaxAttempts()).toBe(3);
    process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "1";
    expect(llmStreamMaxAttempts()).toBe(1);
    process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "99";
    expect(llmStreamMaxAttempts()).toBe(5);
    process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "garbage";
    expect(llmStreamMaxAttempts()).toBe(3);
  });

  it("backs off ~500ms then ~1s", () => {
    expect(streamRetryBackoffMs(1)).toBe(500);
    expect(streamRetryBackoffMs(2)).toBe(1000);
  });
});

describe("executeNative bounded retry loop", () => {
  const savedAttempts = process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"];
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedAttempts === undefined) delete process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"];
    else process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = savedAttempts;
  });

  function newRuntime(): LlmApiRuntime {
    return new LlmApiRuntime({
      type: "api", timeout: 5000, provider: "openai", model: "gpt-test",
      env: { OPENAI_API_KEY: "test-fixture-key" },
    });
  }

  // Make the backoff instant so the loop never sleeps in the test.
  function instantTimers(): void {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  }

  function captureDiag(): { events: DiagnosticEvent[]; release: () => void } {
    const events: DiagnosticEvent[] = [];
    const release = diag.claim({ emit: (e) => { events.push(e); } });
    return { events, release };
  }

  it("retries a transient empty stream and returns the eventual success", async () => {
    process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "3";
    instantTimers();
    const rt = newRuntime();
    const attempt = vi.fn()
      .mockResolvedValueOnce(transient("stream completed without final response"))
      .mockResolvedValueOnce(transient("stream completed without final response"))
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "recovered" }],
        stopReason: "end_turn",
        durationMs: 1,
      } satisfies NativeRuntimeResult);
    (rt as unknown as { executeNativeAttempt: unknown }).executeNativeAttempt = attempt;

    const { events, release } = captureDiag();
    const result = await rt.executeNative("sys", [], []);
    release();

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(events.filter((e) => e.code === "stream_retry")).toHaveLength(2);
  });

  it("stops at the attempt cap and annotates the exhausted error", async () => {
    process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "3";
    instantTimers();
    const rt = newRuntime();
    const attempt = vi.fn().mockResolvedValue(transient("stream completed without final response"));
    (rt as unknown as { executeNativeAttempt: unknown }).executeNativeAttempt = attempt;

    const { events, release } = captureDiag();
    const result = await rt.executeNative("sys", [], []);
    release();

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("stream completed without final response");
    expect(result.error).toContain("retried 3 times");
    expect(events.filter((e) => e.code === "stream_retry")).toHaveLength(2);
  });

  it("does NOT retry a real API error — returns after one attempt", async () => {
    process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "3";
    instantTimers();
    const rt = newRuntime();
    const attempt = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      durationMs: 1,
      error: "OpenAI API error 400: invalid_request_error",
    } satisfies NativeRuntimeResult);
    (rt as unknown as { executeNativeAttempt: unknown }).executeNativeAttempt = attempt;

    const result = await rt.executeNative("sys", [], []);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("OpenAI API error 400: invalid_request_error");
    expect(result.error).not.toContain("retried");
  });

  it("does NOT retry when the operator has already aborted", async () => {
    process.env["ZERO_LLM_STREAM_MAX_ATTEMPTS"] = "3";
    instantTimers();
    const rt = newRuntime();
    const attempt = vi.fn().mockResolvedValue(transient("stream completed without final response"));
    (rt as unknown as { executeNativeAttempt: unknown }).executeNativeAttempt = attempt;

    const controller = new AbortController();
    controller.abort();
    const result = await rt.executeNative("sys", [], [], undefined, controller.signal);

    // One attempt runs (the attempt method itself decides how to treat an
    // already-aborted signal); the loop never schedules a retry.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("error");
  });
});
