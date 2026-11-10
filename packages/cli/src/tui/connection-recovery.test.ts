import { describe, expect, it } from "vitest";
import { connectionRecoveryForError } from "./connection-recovery.js";

describe("connectionRecoveryForError", () => {
  it("routes a broken Codex refresh token into ChatGPT Codex connection", () => {
    const recovery = connectionRecoveryForError(
      "ChatGPT (Codex backend) API error: token refresh failed: 401",
    );
    expect(recovery).toMatchObject({
      providerId: "chatgpt-codex",
    });
  });

  it("does not mistake first-launch provider choices for a failed Codex credential", () => {
    expect(connectionRecoveryForError(
      "No provider credential found. Set OPENAI_API_KEY or ZERO_CHATGPT_OAUTH_REFRESH_TOKEN.",
    )).toBeNull();
  });

  it("routes every configurable API-key provider to its own credential form", () => {
    for (const [error, providerId] of [
      ["Azure OpenAI API error: invalid credential", "azure"],
      ["Anthropic API error: invalid key", "anthropic"],
      ["OpenRouter HTTP 401", "openrouter"],
      ["DeepSeek API error: invalid key", "deepseek"],
      ["Z.ai GLM API error 401: invalid key", "z-ai"],
      ["Moonshot Kimi API error 401: invalid key", "kimi"],
      ["Alibaba Model Studio API error 401: invalid key", "qwen"],
      ["xAI Grok API error 401: invalid key", "xai"],
      ["OpenCode Zen API error 401: invalid key", "opencode"],
      ["Cline API error 401: invalid key for anthropic/claude-sonnet-4-6", "cline"],
      ["Together AI API error 401: invalid api key", "together"],
      ["OpenAI API error: invalid key", "openai"],
    ]) {
      expect(connectionRecoveryForError(error)).toMatchObject({ providerId });
    }
  });


  it("routes a Together failure to Together even when the error names another vendor's model", () => {
    for (const error of [
      "Together AI API error 401: invalid api key for Qwen/Qwen3.5-9B",
      "Together AI API error 403: forbidden for zai-org/GLM-5.3",
      "Together AI API error 401: invalid api key for meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "request to api.together.ai returned 401 unauthorized for deepseek-ai/DeepSeek-V4.1-Flash",
      "TOGETHER_API_KEY rejected: authentication failed",
    ]) {
      expect(connectionRecoveryForError(error)).toMatchObject({ providerId: "together", title: "Together AI credentials need attention" });
    }
  });

  it("does not treat the English word together as a Together AI failure", () => {
    expect(connectionRecoveryForError("OpenAI API error 401: invalid key; keep the request and the key together")).toMatchObject({ providerId: "openai" });
    expect(connectionRecoveryForError("Invalid API key, retry together with the right credentials")).toBeNull();
  });

  it("does not replace model, quota or transport failures with credential setup", () => {
    for (const error of [
      "OpenAI API error 404: unknown model",
      "Anthropic API error 429: rate limit exceeded",
      "ChatGPT Codex API error 500: upstream unavailable",
      "Together AI API error 400: Unable to access non-serverless model meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "Together AI API error 429: rate limit exceeded",
    ]) {
      expect(connectionRecoveryForError(error)).toBeNull();
    }
  });

  it("does not guess a provider from an unattributed API-key error", () => {
    expect(connectionRecoveryForError("Invalid API key")).toBeNull();
  });

  it("keeps non-provider failures in the transcript", () => {
    expect(connectionRecoveryForError("read_file denied outside approved scope")).toBeNull();
  });
});
