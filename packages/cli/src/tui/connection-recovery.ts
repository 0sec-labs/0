export interface ConnectionRecovery {
  providerId: string;
  title: string;
  detail: string;
}

/**
 * Converts an authentication failure into a provider-specific recovery route.
 * Tool, target, and model errors deliberately return null: opening credential
 * setup for those failures would send the operator to the wrong surface.
 */
export function connectionRecoveryForError(error: string): ConnectionRecovery | null {
  const detail = error.trim();
  if (!detail) return null;

  // First launch lists several supported providers in one diagnostic. None of
  // them has failed authentication; keep chat open and let /connect choose.
  if (/no provider credential found/i.test(detail)) return null;

  // Managed-service auth errors do not belong to any model-provider form.
  // Cloud inference is no longer offered by this console.
  if (/0cloud|0[- ]cloud|0 hosted models|RuntimeConfig\.provider\s*=\s*hosted/i.test(detail)) return null;

  // A provider name alone is not an authentication failure. Keep model,
  // balance, rate-limit and transport errors visible in the conversation.
  const status = detail.match(/\b(?:API error|HTTP)\s*:?\s*(\d{3})\b/i)?.[1];
  if (status && status !== "401" && status !== "403") return null;
  if (!/\b(?:401|403|unauthori[sz]ed|forbidden|authentication|credentials?|api[_ ]?key|invalid (?:key|token)|token refresh|refresh[_ ]token)\b/i.test(detail)) return null;

  if (/chatgpt.*codex|codex.*(?:token|auth|login|backend)|0_chatgpt/i.test(detail)) {
    return {
      providerId: "chatgpt-codex",
      title: "ChatGPT Codex needs to reconnect",
      detail,
    };
  }
  if (/azure openai|azure_openai/i.test(detail)) {
    return {
      providerId: "azure",
      title: "Azure OpenAI credentials need attention",
      detail,
    };
  }
  if (/anthropic|claude/i.test(detail)) {
    return {
      providerId: "anthropic",
      title: "Anthropic credentials need attention",
      detail,
    };
  }
  if (/openrouter/i.test(detail)) {
    return {
      providerId: "openrouter",
      title: "OpenRouter credentials need attention",
      detail,
    };
  }
  if (/deepseek/i.test(detail)) {
    return {
      providerId: "deepseek",
      title: "DeepSeek credentials need attention",
      detail,
    };
  }
  if (/\b(?:z[.-]?ai|glm)\b/i.test(detail)) {
    return {
      providerId: "z-ai",
      title: "Z.ai GLM credentials need attention",
      detail,
    };
  }
  if (/moonshot|kimi/i.test(detail)) {
    return {
      providerId: "kimi",
      title: "Moonshot Kimi credentials need attention",
      detail,
    };
  }
  if (/alibaba|qwen/i.test(detail)) {
    return {
      providerId: "qwen",
      title: "Alibaba Qwen credentials need attention",
      detail,
    };
  }
  if (/\bxai\b|x\.ai|grok/i.test(detail)) {
    return {
      providerId: "xai",
      title: "xAI Grok credentials need attention",
      detail,
    };
  }
  if (/opencode|\bzen\b/i.test(detail)) {
    return {
      providerId: "opencode",
      title: "OpenCode Zen credentials need attention",
      detail,
    };
  }
  if (/copilot/i.test(detail)) {
    return {
      providerId: "copilot",
      title: "GitHub Copilot needs to reconnect",
      detail,
    };
  }
  if (/openai/i.test(detail)) {
    return {
      providerId: "openai",
      title: "OpenAI credentials need attention",
      detail,
    };
  }
  return null;
}
