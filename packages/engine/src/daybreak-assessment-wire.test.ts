import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeAssessment } from "./assessment.js";
import { LlmApiRuntime, __resetFallbackChainForTests } from "./runtime/llm-api.js";

// External scanners are deliberately outside this test. Assessment dispatch,
// runtime creation, runner forks, native loop, and file tools remain real.
vi.mock("./shared-analysis.js", async importOriginal => ({
  ...await importOriginal<object>(),
  selectedStaticScanner: () => "foxguard",
  runSelectedStaticScan: () => [],
}));

let directory: string;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  __resetFallbackChainForTests();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it.each([
  { provider: "openai", confirmed: "daybreak_blue" },
  { provider: "openai", confirmed: undefined },
  { provider: "chatgpt-codex", confirmed: "daybreak_blue" },
  { provider: "chatgpt-codex", confirmed: undefined },
] as const)("carries selection through real assessment and tool turns ($provider, receipt $confirmed)", async ({ provider, confirmed }) => {
  directory = mkdtempSync(join(tmpdir(), "daybreak-wire-"));
  const source = join(directory, "fixture.ts");
  const sentinel = "offline_wire_source_sentinel";
  writeFileSync(source, `export const marker = '${sentinel}';\n`);
  for (const [key, value] of Object.entries({
    HOME: directory, OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_WIRE_API: "responses", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "",
    ZERO_DISABLE_HUNT_MEMORY: "1", ZERO_NPM_DYNAMIC_DISCOVERY: "0",
    ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-access-token", ZERO_CHATGPT_ACCOUNT_ID: "synthetic-account",
  })) vi.stubEnv(key, value);
  __resetFallbackChainForTests();
  const forks = vi.spyOn(LlmApiRuntime.prototype, "forkForSubagent");
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe(provider === "openai" ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses");
    const body = JSON.parse(String(init?.body)); requests.push(body);
    expect(requests.length).toBeLessThan(12);
    const output = requests.length === 1
      ? [{ type: "function_call", call_id: "read-source", name: "read_file", arguments: JSON.stringify({ path: source }) }]
      : [{ type: "function_call", call_id: `finish-${requests.length}`, name: "done", arguments: JSON.stringify({ summary: "Inspected the synthetic source; no findings." }) }];
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
      id: `offline-${requests.length}`, status: "completed", output,
      usage: { input_tokens: 3, output_tokens: 2 },
      ...(confirmed ? { access_programs: { cyber: confirmed } } : {}),
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  const result = await executeAssessment({ target: directory, targetType: "source-code", depth: "quick", format: "json",
    runtime: "api", provider, model: "gpt-fixture", apiKey: provider === "openai" ? "synthetic" : undefined, cyberAccessProgram: "daybreak_blue",
    timeout: 15_000, dbPath: join(directory, "assessment.db"),
  });
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(forks).toHaveBeenCalled();
  for (const request of requests) {
    expect(request.access_programs).toEqual({ cyber: "daybreak_blue" });
    expect(request.model).toBe("gpt-fixture");
  }
  // This content can only reach the subsequent request through the real tool
  // executor reading the scoped fixture, rather than a mocked runtime result.
  expect(JSON.stringify(requests[0])).not.toContain(sentinel);
  expect(JSON.stringify(requests.slice(1))).toContain("function_call_output");
  expect(JSON.stringify(requests.slice(1))).toContain(sentinel);
  const metadata = { requested: "daybreak_blue", ...(confirmed ? { confirmed } : {}) };
  expect(result.rawReport.accessProgram).toEqual(metadata);
  expect(result.report.accessProgram).toEqual(metadata);
  expect(result.report.executionSuccessful).not.toBe(false);
}, 30_000);
