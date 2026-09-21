import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LlmApiRuntime, __resetGeminiCodeAssistAuthStateForTests } from "./llm-api.js";
import type { NativeMessage, NativeToolDef } from "./types.js";

/**
 * Google Gemini Code Assist provider.
 *
 * Code Assist is a DISTINCT backend from the public Gemini API: an OAuth Bearer
 * refreshed on demand against oauth2.googleapis.com, a Code Assist project
 * resolved once per credential (loadCodeAssist -> onboardUser -> LRO poll), a
 * request wrapped in a `{ model, project, user_prompt_id, request }` envelope,
 * and a response unwrapped from `{ response }`. These tests pin the two
 * singleflights, the envelope, and the unwrap — mirroring the codex-refresh
 * test's vi.stubGlobal pattern.
 */

const GEMINI_ENV = [
  "ZERO_GEMINI_ACCESS_TOKEN",
  "ZERO_GEMINI_OAUTH_REFRESH_TOKEN",
  "ZERO_GEMINI_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
];

/** A minimal fetch Response whose text()/json() return the given body. */
function res(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

const SYSTEM = "SYS";
const MESSAGES: NativeMessage[] = [
  { role: "user", content: [{ type: "text", text: "audit this" }] },
];
const TOOLS: NativeToolDef[] = [
  { name: "read_file", description: "read a file", input_schema: { type: "object", properties: {} } },
];

function makeRuntime(): LlmApiRuntime {
  return new LlmApiRuntime({
    type: "api",
    timeout: 30_000,
    provider: "google",
    model: "gemini-2.5-pro",
    env: {
      "ZERO_GEMINI_OAUTH_REFRESH_TOKEN": "1//refresh-fixture",
      "ZERO_LLM_FALLBACK": "",
      "ZERO_FORCE_PROVIDER": "",
      "ZERO_SKIP_PROVIDER_BANNER": "1",
    },
  });
}

describe("Google Gemini Code Assist provider", () => {
  beforeEach(() => {
    for (const k of GEMINI_ENV) delete process.env[k];
    __resetGeminiCodeAssistAuthStateForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of GEMINI_ENV) delete process.env[k];
    __resetGeminiCodeAssistAuthStateForTests();
  });

  it("coalesces token refresh + project resolution, wraps the envelope, unwraps the response", async () => {
    let tokenPosts = 0;
    let loadPosts = 0;
    let onboardPosts = 0;
    const genBodies: Array<Record<string, any>> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body?: string }) => {
        const u = String(url);
        if (u === "https://oauth2.googleapis.com/token") {
          tokenPosts += 1;
          return res({ access_token: "ya29.access", expires_in: 3600, token_type: "Bearer" });
        }
        if (u.endsWith(":loadCodeAssist")) {
          loadPosts += 1;
          return res({ allowedTiers: [{ id: "free-tier", isDefault: true, userDefinedCloudaicompanionProject: false }] });
        }
        if (u.endsWith(":onboardUser")) {
          onboardPosts += 1;
          return res({ name: "operations/op-1", done: true, response: { cloudaicompanionProject: { id: "proj-123" } } });
        }
        if (u.endsWith(":generateContent")) {
          genBodies.push(JSON.parse(String(init.body)));
          return res({
            response: {
              candidates: [{
                content: { parts: [{ text: "hi from gemini" }, { functionCall: { name: "read_file", args: { path: "x" } } }] },
                finishReason: "STOP",
              }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
            },
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const rt = makeRuntime();
    expect((rt as any).provider).toBe("google");

    // Two concurrent turns on one runtime share the auth state → the token
    // refresh and the project resolution each happen exactly once.
    const [r1, r2] = await Promise.all([
      rt.executeNative(SYSTEM, MESSAGES, TOOLS),
      rt.executeNative(SYSTEM, MESSAGES, TOOLS),
    ]);

    expect(tokenPosts).toBe(1); // refresh singleflight
    expect(loadPosts).toBe(1); // project-resolution singleflight
    expect(onboardPosts).toBe(1);
    expect(genBodies).toHaveLength(2);

    // Envelope: { model, project, user_prompt_id, request:{...} } — the native
    // generateContent fields are nested under `request`, never at the top level.
    const body = genBodies[0]!;
    expect(body.model).toBe("gemini-2.5-pro");
    expect(body.project).toBe("proj-123");
    expect(typeof body.user_prompt_id).toBe("string");
    expect(body.contents).toBeUndefined();
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
    expect(Array.isArray(body.request.contents)).toBe(true);
    expect(body.request.generationConfig).toBeDefined();
    expect(body.request.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("read_file");

    // Unwrap `{ response: { candidates, usageMetadata } }` → text + tool_use.
    expect(r1.content).toContainEqual({ type: "text", text: "hi from gemini" });
    expect(r1.content.some((b) => b.type === "tool_use" && b.name === "read_file")).toBe(true);
    expect(r1.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(r2.content).toContainEqual({ type: "text", text: "hi from gemini" });
  });

  it("builds the fixed Code Assist endpoint (model in body, not the URL)", () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({})));
    const rt = makeRuntime();
    expect((rt as any).buildUrl()).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
    const headers = (rt as any).buildHeaders() as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toMatch(/^GeminiCLI\//);
    // OAuth bearer is injected pre-flight, not in the static header set.
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["x-goog-api-key"]).toBeUndefined();
  });

  it("polls the onboarding long-running operation until it completes", async () => {
    vi.useFakeTimers();
    let pollGets = 0;
    const genBodies: Array<Record<string, any>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body?: string }) => {
        const u = String(url);
        if (u === "https://oauth2.googleapis.com/token") {
          return res({ access_token: "ya29.access", expires_in: 3600 });
        }
        if (u.endsWith(":loadCodeAssist")) {
          return res({ allowedTiers: [{ id: "free-tier", isDefault: true, userDefinedCloudaicompanionProject: false }] });
        }
        if (u.endsWith(":onboardUser")) {
          return res({ name: "operations/op-2", done: false });
        }
        if (u.includes("/v1internal/operations/op-2")) {
          pollGets += 1;
          return res({ name: "operations/op-2", done: true, response: { cloudaicompanionProject: { id: "proj-777" } } });
        }
        if (u.endsWith(":generateContent")) {
          genBodies.push(JSON.parse(String(init.body)));
          return res({ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    try {
      const rt = makeRuntime();
      const pending = rt.executeNative(SYSTEM, MESSAGES, []);
      // The single 5s LRO poll interval elapses, then the request completes.
      await vi.advanceTimersByTimeAsync(6000);
      const result = await pending;
      expect(pollGets).toBe(1);
      expect(genBodies[0]!.project).toBe("proj-777");
      expect(result.content).toContainEqual({ type: "text", text: "ok" });
    } finally {
      vi.useRealTimers();
    }
  });
});
