import { afterEach, expect, it, vi } from "vitest";
import { assertRequestAdmission, parseRequestAdmission, isLocalAdmissionLimit } from "./request-admission.js";
import { LlmApiRuntime } from "./llm-api.js";
const contract = { schema: "0-inference-request-admission-v1", max_body_bytes: 1048576,
  max_serialized_input_bytes: 262144, counting: "utf8_json_body_plus_framing",
  framing: { base_bytes: 1024, per_message_bytes: 64, per_tool_bytes: 64 } };
const catalog = (c = contract) => ({ data: [{ id: "auto", request_admission: c }] });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("counts UTF8 serialized escaping, messages and tools exactly, accepting the exact boundary", () => {
  const body = JSON.stringify({ input: [{ content: "é😀\n" }], tools: [{}] });
  const bound = Buffer.byteLength(body) + 1024 + 64 + 64;
  const c = parseRequestAdmission(catalog({ ...contract, max_serialized_input_bytes: bound }), "auto");
  expect(() => assertRequestAdmission(body, c)).not.toThrow();
  expect(() => assertRequestAdmission(body, { ...c, maxSerializedInputBytes: bound - 1 })).toThrow("before dispatch");
  expect(() => assertRequestAdmission(body, { ...c, maxSerializedInputBytes: null, maxBodyBytes: Buffer.byteLength(body) - 1 })).toThrow("byte limit");
});
it("fails closed for absent, malformed or wrong model contracts", () => {
  for (const data of [{}, { data: [] }, catalog({ ...contract, counting: "tokens" }), catalog({ ...contract, max_body_bytes: NaN })]) {
    expect(() => parseRequestAdmission(data, "auto")).toThrow("contract");
  }
  expect(() => parseRequestAdmission(catalog(), "other")).toThrow("contract");
});
function runtime(required = true) { return new LlmApiRuntime({ type: "api", provider: "openai", model: "auto", timeout: 1000,
  env: { OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: "http://127.0.0.1:3001/api/inference/v1", OPENAI_WIRE_API: "responses",
    ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_REQUIRE_RETRY_SAFE_RECEIPT: "1", ZERO_REQUIRE_REQUEST_ADMISSION: required ? "1" : "0" } }); }
function post(rt: LlmApiRuntime, body: string) { return (rt as unknown as { postWithRetry(body: () => string, signal: AbortSignal): Promise<Response> })
  .postWithRetry(() => body, new AbortController().signal); }
it("rejects an oversized actual wire body before any POST, and remeasures a compacted body using the same catalog", async () => {
  const fetch = vi.fn(async (_url, init) => init?.method === "POST" ? new Response("ok") : Response.json(catalog())); vi.stubGlobal("fetch", fetch);
  const rt = runtime();
  await expect(post(rt, JSON.stringify({ input: [{ content: "é".repeat(140000) }] }))).rejects.toThrow("LOCAL_REQUEST_ADMISSION_LIMIT");
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][0]).toMatch(/\/models$/);
  await expect(post(rt, JSON.stringify({ input: [{ content: "Compacted" }] }))).resolves.toHaveProperty("status", 200);
  expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][1]?.method).toBe("POST");
});
it("keeps local rejection distinct from unknown provider outcomes through native runtime", async () => {
  const fetch = vi.fn(async () => Response.json(catalog({ ...contract, max_serialized_input_bytes: 1100 }))); vi.stubGlobal("fetch", fetch);
  const result = await runtime().executeNative("Task", [{ role: "user", content: [{ type: "text", text: "x".repeat(1000) }] }], []);
  expect(isLocalAdmissionLimit(result.error)).toBe(true); expect(result.usage).toBeUndefined(); expect(result.error).not.toContain("outcome may be unknown");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not fetch catalogs for ordinary external-provider behavior", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("ok")); vi.stubGlobal("fetch", fetch);
  await post(runtime(false), JSON.stringify({ input: "Fixture" })); expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]?.method).toBe("POST");
});
