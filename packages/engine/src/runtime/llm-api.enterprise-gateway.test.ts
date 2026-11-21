import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";
import { discoverAndRegisterPricing, resetPricingDiscovery } from "../shared/pricing-discovery.js";
import type { NativeMessage, NativeToolDef } from "./types.js";

// Enterprise gateway: a LiteLLM proxy (or any OpenAI-compatible server) in
// front of Bedrock. LiteLLM names models `bedrock/<model-id>` and serves them
// over /chat/completions. These tests stand in for that proxy on loopback and
// check that tool calls round-trip and that nothing else leaves the process.
let server: Server | undefined;
let seen: Array<{ url: string; auth: string | undefined; body: any }> = [];

const BEDROCK_MODEL = "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0";
const tools: NativeToolDef[] = [{ name: "read_file", description: "Read source", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect the source" }] }];

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function gateway(): Promise<string> {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req) || "{}");
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
    const hasToolResult = (body.messages ?? []).some((m: any) => m.role === "tool");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(hasToolResult
      ? { choices: [{ message: { role: "assistant", content: "Reviewed." }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3 } }
      : { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

function runtime(base: string, extra: Record<string, string> = {}) {
  return new LlmApiRuntime({ type: "api", timeout: 5000, provider: "openai", model: BEDROCK_MODEL, singleModel: true,
    env: { OPENAI_API_KEY: "synthetic-gateway-key", OPENAI_BASE_URL: base, OPENAI_WIRE_API: "chat_completions",
      ZERO_SELECTED_PROVIDER: "openai", ZERO_FORCE_PROVIDER: "", ZERO_LLM_FALLBACK: "", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1",
      ZERO_CODEX_AUTH_JSON_PATH: "/nonexistent/0-test/auth.json", ...extra } });
}

beforeEach(() => {
  seen = [];
  for (const key of Object.keys(process.env)) {
    if (/^(?:ZERO_|OPENAI_|OPENROUTER_|ANTHROPIC_|AZURE_OPENAI_|DEEPSEEK_|Z_AI_|KIMI_|QWEN_|XAI_|OPENCODE_|TOGETHER_)/.test(key)) vi.stubEnv(key, undefined);
  }
  resetPricingDiscovery();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPricingDiscovery();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

describe("enterprise OpenAI-compatible gateway (LiteLLM in front of Bedrock)", () => {
  it("round-trips a tool call and its result, sending only to the configured endpoint", async () => {
    const base = await gateway();
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn<typeof fetch>((input, init) => realFetch(input, init));
    vi.stubGlobal("fetch", fetchSpy);
    // Telemetry off, as an enterprise deployment would set it.
    vi.stubEnv("ZERO_NO_TELEMETRY", "1");

    const rt = runtime(base);
    const first = await rt.executeNative("Review carefully", messages, tools);
    expect(first.stopReason).toBe("tool_use");
    expect(first.content).toEqual(expect.arrayContaining([{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "src/main.ts" } }]));
    const second = await rt.executeNative("Review carefully", [...messages,
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "export const answer = 42;" }] },
    ], tools);
    expect(second.stopReason).toBe("end_turn");

    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe("/v1/chat/completions");
    expect(seen[0].auth).toBe("Bearer synthetic-gateway-key");
    expect(seen[0].body.model).toBe(BEDROCK_MODEL);
    expect(seen[0].body.tools[0].function.name).toBe("read_file");
    expect(seen[1].body.messages).toEqual(expect.arrayContaining([{ role: "tool", tool_call_id: "call_1", content: "export const answer = 42;" }]));

    // Every outbound request, and the pricing lookup for this unpriced model,
    // stayed on the gateway origin.
    await discoverAndRegisterPricing(BEDROCK_MODEL);
    const origins = new Set(fetchSpy.mock.calls.map(([input]) => new URL(String(input instanceof Request ? input.url : input)).origin));
    expect([...origins]).toEqual([new URL(base).origin]);
  });

  it("does not look up pricing at a third-party catalog when telemetry is off", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    for (const name of ["ZERO_NO_TELEMETRY", "ZERO_OFFLINE", "DO_NOT_TRACK"]) {
      vi.stubEnv(name, "1");
      await discoverAndRegisterPricing(`bedrock/unpriced-${name.toLowerCase()}`);
      vi.stubEnv(name, undefined);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still looks pricing up when no opt-out is set", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    await discoverAndRegisterPricing("bedrock/unpriced-control-model");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
