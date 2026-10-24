import { afterEach, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";
import { budgetNativeRuntime } from "../scan-plan.js";
import { ScanCostLedger } from "../agent/cost-ledger.js";
import type { NativeMessage } from "./types.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("executes explicit multi-task model assignments with tool evidence and one usage account", async () => {
  const trace: Array<{ model: string; body: string }> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    trace.push({ model: body.model, body: JSON.stringify(body) });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-account");
    expect(JSON.stringify(body)).toContain("Only https://target.test/allowed");
    const first = trace.length === 1;
    return Response.json({
      choices: [{ message: first
        ? { role: "assistant", content: null, tool_calls: [{ id: "proof-call", type: "function", function: { name: "read_evidence", arguments: '{"id":"fixture-evidence"}' } }] }
        : { role: "assistant", content: body.model === "gpt-4o" ? "Evidence remains unverified until deterministic replay." : "Preserve fixture-evidence and its unverified state." },
        finish_reason: first ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
  });
  const ledger = new ScanCostLedger();
  const runtime = budgetNativeRuntime(new LlmApiRuntime({ type: "api", provider: "openai", model: "gpt-4o-mini", timeout: 1_000,
    agentModels: { discovery: "gpt-4o-mini", verify: "gpt-4o", report: "gpt-4o-mini" },
    env: { OPENAI_API_KEY: "fixture-account", OPENAI_BASE_URL: "https://provider.fixture/v1", OPENAI_WIRE_API: "chat_completions", ZERO_FORCE_PROVIDER: "", ZERO_SELECTED_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SKIP_PROVIDER_BANNER: "1" },
  }), ledger, undefined, 1);
  const system = "Only https://target.test/allowed is authorized. Evidence fixture-evidence is unverified. A model switch cannot confirm it.";
  const tools = [{ name: "read_evidence", description: "Read retained evidence", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }];
  const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Investigate the authorized surface." }] }];
  const discovery = await runtime.forkForSubagent!(1_000, { role: "discovery" });
  const lead = await discovery.executeNative(system, messages, tools);
  expect(lead.stopReason).toBe("tool_use");
  messages.push({ role: "assistant", content: lead.content });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "proof-call", content: '{"id":"fixture-evidence","validation":"unverified","status":200}' }] });
  const verify = await runtime.forkForSubagent!(1_000, { role: "verify" });
  const verification = await verify.executeNative(system, messages, tools);
  expect(verification.stopReason).toBe("end_turn");
  messages.push({ role: "assistant", content: verification.content });
  const report = await runtime.forkForSubagent!(1_000, { role: "report" });
  await report.executeNative(system, messages, tools);
  expect(trace.map(call => call.model)).toEqual(["gpt-4o-mini", "gpt-4o", "gpt-4o-mini"]);
  expect(trace[1]!.body).toContain("fixture-evidence");
  expect(trace[1]!.body).toContain("unverified");
  expect(trace[2]!.body).toContain("unverified");
  expect(ledger.tokenUsage()).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  expect(ledger.totalCostUsd()).toBeGreaterThan(0);
});
