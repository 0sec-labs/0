import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";
import type { NativeMessage } from "./types.js";

/**
 * GitHub Copilot provider wire guard.
 *
 * Copilot rides the OpenAI `chat_completions` wire, but the endpoint requires a
 * set of static VS Code Copilot Chat integration headers alongside the Bearer,
 * and the `copilot/` model prefix must be stripped before the request. The
 * device-flow access token (ZERO_COPILOT_GITHUB_TOKEN) is sent DIRECTLY as the
 * Bearer — no secondary token exchange and no refresh.
 */
describe("GitHub Copilot provider wire", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clear every provider credential so detection is deterministic.
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    delete process.env.QWEN_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env["ZERO_MODEL"];
    delete process.env["ZERO_CHATGPT_ACCESS_TOKEN"];
    delete process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
    delete process.env.COPILOT_BASE_URL;
    process.env["ZERO_CHATGPT_AUTH_FILE"] = "/tmp/0-copilot-test-no-auth.json";
    process.env["ZERO_SKIP_PROVIDER_BANNER"] = "1";
    process.env["ZERO_COPILOT_GITHUB_TOKEN"] = "gho_copilot_token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
  });

  it("selects copilot for a copilot/-prefixed model, stripping the prefix", () => {
    const rt = new LlmApiRuntime({ type: "api", timeout: 5000, model: "copilot/gpt-4o" });
    expect((rt as any).provider).toBe("copilot");
    // Prefix stripped so the endpoint receives the canonical id.
    expect((rt as any).model).toBe("gpt-4o");
    expect((rt as any).baseUrl).toBe("https://api.githubcopilot.com");
  });

  it("routes to api.githubcopilot.com/chat/completions with the Bearer + Copilot headers", () => {
    const rt = new LlmApiRuntime({ type: "api", timeout: 5000, model: "copilot/gpt-4o" });

    expect((rt as any).buildUrl()).toBe("https://api.githubcopilot.com/chat/completions");

    const headers = (rt as any).buildHeaders() as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer gho_copilot_token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(headers["Editor-Version"]).toBe("vscode/1.99.3");
    expect(headers["Editor-Plugin-Version"]).toBe("copilot-chat/0.26.7");
    expect(headers["X-GitHub-Api-Version"]).toBe("2026-06-01");
    expect(headers["Openai-Intent"]).toBe("conversation-edits");
    expect(headers["X-Initiator"]).toBe("user");
    // Never the Anthropic x-api-key on this wire.
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("sends a request to the Copilot endpoint with all Copilot headers present", async () => {
    const rt = new LlmApiRuntime({ type: "api", timeout: 5000, model: "copilot/gpt-4o" });

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: { headers: Record<string, string>; body: string }) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedBody = JSON.parse(opts.body) as Record<string, unknown>;
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: "copilot ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 12, completion_tokens: 4 },
            }),
        } as unknown as Response;
      }),
    );

    const messages: NativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "audit this target" }] },
    ];
    const result = await rt.executeNative("SYSTEM PROMPT", messages, []);

    expect(capturedUrl).toBe("https://api.githubcopilot.com/chat/completions");
    expect(capturedHeaders["Authorization"]).toBe("Bearer gho_copilot_token");
    expect(capturedHeaders["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(capturedHeaders["Editor-Version"]).toBe("vscode/1.99.3");
    expect(capturedHeaders["Editor-Plugin-Version"]).toBe("copilot-chat/0.26.7");
    expect(capturedHeaders["X-GitHub-Api-Version"]).toBe("2026-06-01");
    expect(capturedHeaders["Openai-Intent"]).toBe("conversation-edits");
    expect(capturedHeaders["X-Initiator"]).toBe("user");
    // The wire model id is the stripped, canonical form.
    expect(capturedBody.model).toBe("gpt-4o");
    expect(result.content).toContainEqual({ type: "text", text: "copilot ok" });
  });


  it("honors COPILOT_BASE_URL for the enterprise/business endpoint override", () => {
    process.env.COPILOT_BASE_URL = "https://api.business.githubcopilot.com";
    const rt = new LlmApiRuntime({ type: "api", timeout: 5000, model: "copilot/gpt-4o" });
    expect((rt as any).baseUrl).toBe("https://api.business.githubcopilot.com");
    expect((rt as any).buildUrl()).toBe("https://api.business.githubcopilot.com/chat/completions");
  });
});
