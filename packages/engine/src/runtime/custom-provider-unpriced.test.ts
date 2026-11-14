import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SecurityWorkflowInput } from "../shared/index.js";
import { LlmApiRuntime } from "./llm-api.js";
import { budgetNativeRuntime } from "../scan-plan.js";
import { executeWorkflow } from "../workflow-runner.js";
import { runNativeAgentLoop } from "../agent/native-loop.js";

// Issue #312: a free or custom OpenAI-compatible provider has no pricing entry.
// Its cost is unknown, not an error, so a run must not abort over it.
let home: string;
let server: Server | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0-unpriced-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  vi.stubEnv("ZERO_NO_TELEMETRY", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

const workflow: SecurityWorkflowInput = { name: "Free provider fixture", instructions: "Offline fixture", target: "fixture", nodes: [
  { id: "start", type: "trigger", label: "Start", enabled: true },
  { id: "first", type: "audit", label: "First", enabled: true },
  { id: "second", type: "audit", label: "Second", enabled: true },
], edges: [{ source: "start", target: "first" }, { source: "first", target: "second" }] };

async function run(usage: unknown, cap: number) {
  let requests = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "fake", choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
        ...(usage === undefined ? {} : { usage }) }));
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const runtime = new LlmApiRuntime({ type: "api", timeout: 5000, provider: "openai", model: "free-model-with-no-price-entry", singleModel: true,
    env: { OPENAI_API_KEY: "synthetic-only", OPENAI_BASE_URL: base, OPENAI_WIRE_API: "chat_completions",
      ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } });
  const result = await executeWorkflow({ workflow, costCapUsd: cap, timeCapMs: 20_000, executeAssessment: async context => {
    const state = await runNativeAgentLoop({ runtime: budgetNativeRuntime(runtime, context.costLedger, context.signal, context.plan.costCapUsd, context.plan), db: null,
      signal: context.signal, costLedger: context.costLedger,
      config: { role: "audit", systemPrompt: "Synthetic offline check only.", tools: [], maxTurns: 1, target: "fixture", scanId: `free-${context.node.id}` } });
    return { status: state.done && !state.errorExit ? "completed" : "failed", error: state.errorExit?.error };
  } });
  return { result, requests: () => requests };
}

it("completes both steps for an unpriced model that reports usage, treating its cost as unknown", async () => {
  const { result, requests } = await run({ prompt_tokens: 5_000_000, completion_tokens: 1_000_000, total_tokens: 6_000_000 }, 0.01);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe("completed");
  expect(requests()).toBe(2);
  expect(result.costUsd).toBe(0);
});

it("completes both steps for an unpriced model whose responses omit usage", async () => {
  const { result, requests } = await run(undefined, 0.01);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe("completed");
  expect(requests()).toBe(2);
});
