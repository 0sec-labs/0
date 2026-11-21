import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeApiRuntime } from "../native-api.js";
import { selectRuntimeKind } from "../api-runtime.js";
import { resolvePiRoute } from "./route.js";
import { resolveFailoverProvider } from "../llm-api/fallback.js";
import { detectProvider } from "../llm-api/provider-detect.js";
import type { NativeMessage, NativeToolDef } from "../types.js";

// Amazon Bedrock through the AWS SDK (pi-ai bedrock-converse-stream). A loopback
// server speaks the ConverseStream wire (AWS event-stream framing), so the real
// SDK client runs end to end without any AWS account.
let server: Server | undefined;
let requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: any }> = [];

function frame(eventType: string, payload: unknown): Buffer {
  const header = (name: string, value: string): Buffer => {
    const n = Buffer.from(name), v = Buffer.from(value);
    return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), Buffer.from([v.length >> 8, v.length & 255]), v]);
  };
  const headers = Buffer.concat([header(":message-type", "event"), header(":event-type", eventType), header(":content-type", "application/json")]);
  const body = Buffer.from(JSON.stringify(payload));
  const total = 16 + headers.length + body.length;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4); preludeCrc.writeUInt32BE(crc32(prelude) >>> 0);
  const withoutCrc = Buffer.concat([prelude, preludeCrc, headers, body]);
  const msgCrc = Buffer.alloc(4); msgCrc.writeUInt32BE(crc32(withoutCrc) >>> 0);
  return Buffer.concat([withoutCrc, msgCrc]);
}

async function mockBedrock(): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      const afterTool = JSON.stringify(body.messages ?? []).includes("toolResult");
      const events = afterTool
        ? [frame("messageStart", { role: "assistant" }),
          frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Reviewed." } }), frame("contentBlockStop", { contentBlockIndex: 0 }),
          frame("messageStop", { stopReason: "end_turn" }), frame("metadata", { usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34 }, metrics: { latencyMs: 1 } })]
        : [frame("messageStart", { role: "assistant" }),
          frame("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tooluse_1", name: "read_file" } } }),
          frame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":"src/main.ts"}' } } }), frame("contentBlockStop", { contentBlockIndex: 0 }),
          frame("messageStop", { stopReason: "tool_use" }), frame("metadata", { usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 }, metrics: { latencyMs: 1 } })];
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      res.end(Buffer.concat(events));
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const MODEL = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
const tools: NativeToolDef[] = [{ name: "read_file", description: "Read source", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect the source" }] }];

beforeEach(() => {
  requests = [];
  for (const key of Object.keys(process.env)) {
    if (/^(?:ZERO_|OPENAI_|OPENROUTER_|ANTHROPIC_|AZURE_OPENAI_|DEEPSEEK_|Z_AI_|KIMI_|QWEN_|XAI_|OPENCODE_|TOGETHER_|AWS_|BEDROCK_)/.test(key)) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("ZERO_CODEX_AUTH_JSON_PATH", "/nonexistent/0-test/auth.json");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

describe("Amazon Bedrock provider", () => {
  it("is never picked from ambient AWS variables, only by explicit selection", () => {
    const env = { AWS_REGION: "eu-central-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1" } as NodeJS.ProcessEnv;
    expect(() => detectProvider(undefined, undefined, env)).not.toThrow(/bedrock/);
    expect((() => { try { return detectProvider(undefined, undefined, env).provider; } catch { return undefined; } })()).not.toBe("bedrock");
    const pinned = detectProvider(undefined, MODEL, { ...env, ZERO_SELECTED_PROVIDER: "bedrock" });
    expect(pinned).toMatchObject({ provider: "bedrock", baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com", defaultModel: MODEL });
  });

  it("reports not configured when no AWS credential source is present", () => {
    expect(resolveFailoverProvider("bedrock", MODEL, {})).toBeUndefined();
    expect(resolveFailoverProvider("bedrock", MODEL, { AWS_PROFILE: "audit" })).toMatchObject({ baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" });
    expect(() => detectProvider(undefined, MODEL, { ZERO_SELECTED_PROVIDER: "bedrock" })).toThrow(/no configured credentials/);
  });

  it("routes through pi-ai even when ZERO_RUNTIME=legacy, and honours BEDROCK_BASE_URL", () => {
    const env = { ZERO_SELECTED_PROVIDER: "bedrock", ZERO_MODEL: MODEL, ZERO_RUNTIME: "legacy", AWS_PROFILE: "audit", BEDROCK_BASE_URL: "https://vpce.internal.example" } as NodeJS.ProcessEnv;
    expect(selectRuntimeKind({ type: "api", timeout: 1000, env: env as Record<string, string> })).toBe("pi-ai");
    expect(resolvePiRoute({ type: "api", timeout: 1000 }, env)).toMatchObject({ piProvider: "amazon-bedrock", api: "bedrock-converse-stream", baseUrl: "https://vpce.internal.example", model: MODEL });
  });

  it("completes a tool-call round trip over the ConverseStream wire with the AWS credential chain", async () => {
    const endpoint = await mockBedrock();
    const runtime = createNativeApiRuntime({ type: "api", timeout: 10_000, provider: "bedrock", model: MODEL, singleModel: true, env: {
      ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_LLM_FALLBACK: "", BEDROCK_BASE_URL: endpoint, AWS_BEDROCK_FORCE_HTTP1: "1",
      AWS_ACCESS_KEY_ID: "AKIATESTONLY", AWS_SECRET_ACCESS_KEY: "synthetic-secret", AWS_REGION: "eu-central-1", ZERO_NO_TELEMETRY: "1" } });
    expect(runtime.resolvedProvider()).toBe("bedrock");

    const first = await runtime.executeNative("Review carefully", messages, tools);
    expect(first.error).toBeUndefined();
    expect(first.stopReason).toBe("tool_use");
    expect(first.content).toEqual(expect.arrayContaining([{ type: "tool_use", id: "tooluse_1", name: "read_file", input: { path: "src/main.ts" } }]));
    expect(first.usage).toMatchObject({ inputTokens: 12, outputTokens: 7 });

    const second = await runtime.executeNative("Review carefully", [...messages,
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tooluse_1", content: "export const answer = 42;" }] },
    ], tools);
    expect(second.error).toBeUndefined();
    expect(second.stopReason).toBe("end_turn");
    expect(second.content).toEqual([{ type: "text", text: "Reviewed." }]);

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(`/model/${encodeURIComponent(MODEL)}/converse-stream`);
    // SigV4 from the credential chain, never a bearer token.
    expect(String(requests[0].headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTONLY\/\d{8}\/eu-central-1\/bedrock\//);
    expect(requests[0].body.toolConfig.tools[0].toolSpec.name).toBe("read_file");
    expect(JSON.stringify(requests[1].body.messages)).toContain("tooluse_1");
  });

  it("uses AWS_BEARER_TOKEN_BEDROCK as a bearer token when set", async () => {
    const endpoint = await mockBedrock();
    const runtime = createNativeApiRuntime({ type: "api", timeout: 10_000, provider: "bedrock", model: MODEL, singleModel: true, env: {
      ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_LLM_FALLBACK: "", BEDROCK_BASE_URL: endpoint, AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEARER_TOKEN_BEDROCK: "synthetic-bearer-token" } });
    const result = await runtime.executeNative("Review", messages, tools);
    expect(result.error).toBeUndefined();
    expect(String(requests[0].headers.authorization)).toBe("Bearer synthetic-bearer-token");
  });
});
