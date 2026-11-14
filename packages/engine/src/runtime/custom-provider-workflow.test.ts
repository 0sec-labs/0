import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SecurityWorkflowInput } from "../shared/index.js";
import { LlmApiRuntime } from "./llm-api.js";
import { budgetNativeRuntime } from "../scan-plan.js";
import { executeWorkflow } from "../workflow-runner.js";
import { runNativeAgentLoop } from "../agent/native-loop.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0-custom-workflow-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  vi.stubEnv("ZERO_NO_TELEMETRY", "1");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const workflow: SecurityWorkflowInput = { name: "Custom provider receipt fixture", instructions: "Offline fixture", target: "fixture", nodes: [
  { id: "start", type: "trigger", label: "Start", enabled: true },
  { id: "first", type: "audit", label: "First", enabled: true },
  { id: "second", type: "audit", label: "Second", enabled: true },
], edges: [{ source: "start", target: "first" }, { source: "first", target: "second" }] };

async function run(usage: unknown, cap = 1) {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(String(url)).toBe("https://groq.fixture/openai/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("synthetic-groq-custom-model");
    expect(body.stream).not.toBe(true); // This path uses non-streaming receipts.
    calls.push(body);
    // Groq's documented non-streaming usage is top-level. x_groq.usage carries
    // hardware-cache metrics, not an alternative billable token total.
    return Response.json({ id: "fixture", choices: [{ message: { role: "assistant", content: "Bounded fixture inspection completed." }, finish_reason: "stop" }],
      ...(usage === undefined ? {} : { usage }), x_groq: { id: "synthetic-request", usage: { dram_cached_tokens: 2, sram_cached_tokens: 1 } } });
  }));
  const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "openai", model: "synthetic-groq-custom-model", singleModel: true,
    env: { OPENAI_API_KEY: "synthetic-only", OPENAI_BASE_URL: "https://groq.fixture/openai/v1", OPENAI_WIRE_API: "chat_completions",
      ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } });
  const result = await executeWorkflow({ workflow, costCapUsd: cap, timeCapMs: 10_000, executeAssessment: async context => {
    const state = await runNativeAgentLoop({ runtime: budgetNativeRuntime(runtime, context.costLedger, context.signal, context.plan.costCapUsd, context.plan), db: null,
      signal: context.signal, costLedger: context.costLedger,
      config: { role: "audit", systemPrompt: "Synthetic offline receipt check only.", tools: [], maxTurns: 1, target: "fixture", scanId: `custom-${context.node.id}` } });
    return { status: state.done && !state.errorExit ? "completed" : "failed", error: state.errorExit?.message };
  } });
  return { result, calls };
}

it("runs an uncatalogued custom model through real runtime, native loop and both workflow steps", async () => {
  const { result, calls } = await run({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 }, total_tokens: 110 });
  expect(result.status).toBe("completed");
  expect(calls).toHaveLength(2);
  expect(result.costUsd).toBeGreaterThan(0); // Unknown tariffs use conservative estimates, never an invented free price.
  expect(result.nodeResults.second?.status).toBe("completed");
});

it("still enforces the monetary ceiling for a custom model with valid usage", async () => {
  const { result, calls } = await run({ prompt_tokens: 100, completion_tokens: 10 }, 0.000001);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("cost ceiling");
  expect(calls).toHaveLength(1);
  expect(result.nodeResults.second?.status).toBe("blocked");
});

it.each([undefined, {}, { prompt_tokens: 100 }, { prompt_tokens: 100, completion_tokens: -1 }, { prompt_tokens: "100", completion_tokens: 10 }, { prompt_tokens: null, completion_tokens: 10 }])
("retains missing or invalid usage as unknown and blocks the next workflow step: %j", async usage => {
  const { result, calls } = await run(usage);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("token usage is unavailable or invalid");
  expect(result.error).toContain("complete token usage receipts");
  expect(result.costUsd).toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(result.nodeResults.second?.status).toBe("blocked");
});
