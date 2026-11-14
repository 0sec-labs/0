import type { ModelsResponse } from "@/components/console-control/contracts";
import { needsProviderSignIn } from "./provider-error";

export function errorProvider(message: string, fallback?: string): string | undefined {
  if (!needsProviderSignIn(message)) return undefined;
  if (/Codex|ChatGPT/i.test(message)) return "chatgpt-codex";
  const providers: [RegExp, string][] = [[/DeepSeek/i, "deepseek"], [/Anthropic/i, "anthropic"], [/OpenRouter/i, "openrouter"], [/Gemini|Google/i, "google"], [/Cline/i, "cline"], [/Azure/i, "azure"], [/OpenAI/i, "openai"]];
  return providers.find(([pattern]) => pattern.test(message))?.[1] ?? fallback;
}

/** Configured credentials and public model catalogs do not verify account access. */
export function connectionVerified(providerId: string, result: ModelsResponse): boolean {
  return result.providerId === providerId
    && !result.diagnostics.some(item => item.providerId === providerId)
    && result.models.some(item => item.provider === providerId && item.source === "account");
}

export interface ConnectionRecovery {
  providerId: string;
  healthy: boolean;
  checking: boolean;
}
export function recoveredProviderError(message: string, recovery?: ConnectionRecovery): boolean {
  return Boolean(recovery?.healthy && errorProvider(message, recovery.providerId) === recovery.providerId);
}
