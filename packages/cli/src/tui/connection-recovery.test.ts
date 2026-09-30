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
      ["OpenAI API error: invalid key", "openai"],
    ]) {
      expect(connectionRecoveryForError(error)).toMatchObject({ providerId });
    }
  });


  it("does not replace model, quota or transport failures with credential setup", () => {
    for (const error of [
      "OpenAI API error 404: unknown model",
      "Anthropic API error 429: rate limit exceeded",
      "ChatGPT Codex API error 500: upstream unavailable",
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
