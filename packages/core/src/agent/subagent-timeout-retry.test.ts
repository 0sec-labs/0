import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { LlmApiRuntime } from "../runtime/llm-api.js";
import { eventBus, type SubagentLifecyclePayload } from "../events/bus.js";
import { ToolExecutor } from "./tools.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(delay).mockReset();
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  eventBus.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  eventBus.clear();
});

function setup() {
  const parent = new LlmApiRuntime({
    type: "api", provider: "openrouter", model: "openai/gpt-test", timeout: 25,
    env: {
      OPENROUTER_API_KEY: "fixture-key", ZERO_FORCE_PROVIDER: "",
      ZERO_SELECTED_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1",
    },
  });
  const executor = new ToolExecutor({
    target: "https://target.test", scanId: "timeout-parent", role: "discovery",
    findings: [], attackResults: [], targetInfo: {},
  }, undefined, undefined, parent.forkForSubagent.bind(parent));
  const lifecycle: SubagentLifecyclePayload[] = [];
  eventBus.subscribe({ emit: (type, payload) => {
    if (type === "subagent_lifecycle") lifecycle.push(payload as SubagentLifecyclePayload);
  } });
  return { parent, executor, lifecycle };
}

function hangingFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  });
}

function stalledRequest() {
  let notify!: () => void;
  const started = new Promise<void>(resolve => { notify = resolve; });
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    notify();
    return hangingFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, started };
}

function doneResponse(): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{
      id: "done-call", type: "function", function: { name: "done", arguments: JSON.stringify({ summary: "Recovered child" }) },
    }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

describe("OpenRouter subagent timeout retry", () => {
  it.each(["spawn_agent", "spawn_agents"])("%s retries a timed-out request without consuming a turn", async (name) => {
    const { parent, executor, lifecycle } = setup();
    const { fetchMock, started } = stalledRequest();
    fetchMock.mockImplementationOnce(fetchMock.getMockImplementation()!).mockResolvedValueOnce(doneResponse());
    const task = { task: "Complete the delegated task", max_turns: 1 };
    const pending = executor.execute({ name, arguments: name === "spawn_agent" ? task : { tasks: [task] } });
    await started;
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]!.body).toBe(fetchMock.mock.calls[0]![1]!.body);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions",
    ]);
    expect(result.success).toBe(true);
    expect(lifecycle.map(event => event.status)).toEqual(["queued", "running", "completed"]);
    expect(lifecycle.at(-1)).toMatchObject({ turns: 1, done: true, summary: "Recovered child" });
    expect(parent.resolvedProvider()).toBe("openrouter");
    expect(parent.resolvedModel()).toBe("openai/gpt-test");
  });

  it("fails after the existing six retries when every request times out", async () => {
    // Fake timers do not replace node:timers/promises. Skip only this test's
    // backoff waits; recovery and cancellation tests use the real delay.
    vi.mocked(delay).mockResolvedValue(undefined);
    const { executor, lifecycle } = setup();
    const { fetchMock, started } = stalledRequest();
    const pending = executor.execute({ name: "spawn_agent", arguments: { task: "Complete the delegated task", max_turns: 1 } });
    await started;
    await vi.advanceTimersByTimeAsync(80_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result).toMatchObject({ success: false, error: "OpenRouter API request timed out" });
    expect(lifecycle.map(event => event.status)).toEqual(["queued", "running", "failed"]);
  });

  it("does not retry an operator cancellation during a request", async () => {
    const { executor } = setup();
    const controller = new AbortController();
    const { fetchMock, started } = stalledRequest();
    const pending = executor.execute({ name: "spawn_agent", arguments: { task: "Complete the delegated task" } }, { signal: controller.signal });
    await started;
    controller.abort();
    await vi.advanceTimersByTimeAsync(80_000);
    expect((await pending).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops a timeout retry backoff when the operator cancels", async () => {
    const { executor } = setup();
    const controller = new AbortController();
    const { fetchMock, started } = stalledRequest();
    const pending = executor.execute({ name: "spawn_agent", arguments: { task: "Complete the delegated task" } }, { signal: controller.signal });
    await started;
    // The 25ms request deadline has elapsed; the 1s retry backoff is pending.
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(80_000);
    expect((await pending).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry an authentication failure", async () => {
    const { executor } = setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executor.execute({ name: "spawn_agent", arguments: { task: "Complete the delegated task" } });
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
