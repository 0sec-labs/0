import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./smolvm-broker.js", () => ({ isAdmittedSmolvmWorkbench: () => true }));
import { LlmApiRuntime } from "./llm-api.js";
import type { NativeRuntimeResult, RuntimeResult } from "./types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Source = "runtime-first" | "operator-first" | "transport-error";
const branches = [
  { transport: "http", method: "native" },
  { transport: "http", method: "legacy" },
  { transport: "proxy", method: "native" },
  { transport: "proxy", method: "legacy" },
] as const;

describe.each(branches)("timeout origin: $transport $method", ({ transport, method }) => {
  it.each<Source>(["runtime-first", "operator-first", "transport-error"])("classifies %s from signal ownership even when the transport removes AbortError", async source => {
    vi.useFakeTimers();
    const operator = new AbortController();
    const aborted = vi.fn();
    let entered = false;
    const request = (signal?: AbortSignal | null): Promise<Response> => {
      entered = true;
      if (source === "transport-error") return Promise.reject(new Error("Local provider request cancelled."));
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => {
          aborted();
          // Delay the rejection until both independent signals have fired.
          // Classification must retain the FIRST source, not inspect the later operator state.
          setTimeout(() => reject(new Error("Local provider request cancelled.")), 30);
        }, { once: true });
      });
    };
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => request(init?.signal));
    vi.stubGlobal("fetch", fetch);
    const runtime = transport === "proxy"
      ? new LlmApiRuntime({ type: "api", timeout: 20, env: {
        ZERO_WORKBENCH_PROVIDER_PROXY: "http://127.0.0.1:43210/provider/request", ZERO_WORKBENCH_PROVIDER_MODEL: "gpt-5.6-sol",
        ZERO_SELECTED_PROVIDER: "chatgpt-codex", ZERO_FORCE_PROVIDER: "chatgpt-codex", ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1",
      } })
      : new LlmApiRuntime({ type: "api", timeout: 20, provider: "openai", model: "gpt-4o", env: {
        OPENAI_API_KEY: "synthetic-unused-credential", OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_WIRE_API: "chat_completions", ZERO_WORKBENCH_PROVIDER_PROXY: "",
        ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1",
      } });
    const pending = method === "native"
      ? runtime.executeNative("Synthetic cancellation control", [{ role: "user", content: [{ type: "text", text: "No model execution." }] }], [], undefined, operator.signal)
      : runtime.execute("No model execution.", { signal: operator.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(entered).toBe(true);
    if (source !== "transport-error") setTimeout(() => operator.abort(), source === "operator-first" ? 5 : 21);
    await vi.advanceTimersByTimeAsync(60);
    const result: NativeRuntimeResult | RuntimeResult = await pending;
    const cancelled = "stopReason" in result ? result.cancelled === true : result.exitCode === null;

    if (source === "runtime-first") {
      expect(operator.signal.aborted).toBe(true);
      expect(result.timedOut).toBe(true);
      expect(cancelled).toBe(false);
      expect(result.error).toContain("API request timed out");
    } else if (source === "operator-first") {
      expect(result.timedOut === true).toBe(false);
      expect(cancelled).toBe(true);
      expect(result.error).toMatch(/cancelled/);
      expect(result.error).not.toContain("timed out");
    } else {
      expect(result.timedOut === true).toBe(false);
      expect(cancelled).toBe(false);
      expect(result.error).toContain("API error");
      expect(aborted).not.toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(transport === "proxy"
      ? "http://127.0.0.1:43210/provider/request"
      : "https://api.openai.com/v1/chat/completions");
  });
});
