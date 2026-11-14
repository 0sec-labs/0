import { type RuntimeResult, type NativeContentBlock } from "../types.js";
import { type WireBlock } from "../prompt-cache.js";

/**
 * Explicit output bound used on every provider route that accepts one.
 * ChatGPT Codex OAuth rejects an explicit Responses cap; callers that require
 * a hard monetary ceiling must reject that route before making a request.
 */
export const NATIVE_COMPLETION_TOKEN_LIMIT = 8192;
/** Provider usage must contain genuine, bounded integer token counts. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Invalid cache metadata cannot earn a discount; retain full-price input. */
export function readResponsesCachedTokens(usage: Record<string, unknown>): { cachedInputTokens?: number } {
  const details = usage.input_tokens_details as Record<string, unknown> | undefined;
  const cached = details?.cached_tokens;
  return isTokenCount(cached) && cached > 0 && isTokenCount(usage.input_tokens) && cached <= usage.input_tokens
    ? { cachedInputTokens: cached } : {};
}
export function readResponsesUsage(raw: unknown): RuntimeResult["usage"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;
  if (!isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) return undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, ...readResponsesCachedTokens(usage) };
}
export function readChatUsage(raw: unknown): RuntimeResult["usage"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;
  if (!isTokenCount(usage.prompt_tokens) || !isTokenCount(usage.completion_tokens)) return undefined;
  return {
    inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
    ...readResponsesCachedTokens({ input_tokens: usage.prompt_tokens, input_tokens_details: usage.prompt_tokens_details }),
  };
}

export function readGoogleUsage(raw: unknown): RuntimeResult["usage"] {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  if (usage.promptTokenCount === undefined && usage.candidatesTokenCount === undefined) return undefined;
  const cached = Number(usage.cachedContentTokenCount ?? 0);
  return {
    inputTokens: Number(usage.promptTokenCount ?? 0),
    outputTokens: Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

/** Safely parse JSON tool arguments; returns empty object on malformed input. */
export function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

/** A completed Responses envelope is necessary, but malformed calls still fail closed. */
export function parseResponsesFunctionCall(item: Record<string, unknown>): Extract<NativeContentBlock, { type: "tool_use" }> | undefined {
  if ((item.status !== undefined && item.status !== "completed") ||
      typeof item.call_id !== "string" || !item.call_id.trim() ||
      typeof item.name !== "string" || !item.name.trim() ||
      typeof item.arguments !== "string") return undefined;
  try {
    const input: unknown = JSON.parse(item.arguments);
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    return { type: "tool_use", id: item.call_id, name: item.name, input: input as Record<string, unknown> };
  } catch {
    return undefined;
  }
}


/** True when persisted provider output is safe to replay as Anthropic blocks. */
export function isWireBlockArray(blocks: unknown[]): blocks is WireBlock[] {
  return blocks.every(
    (block) =>
      block !== null
      && typeof block === "object"
      && !Array.isArray(block)
      && typeof (block as Record<string, unknown>).type === "string",
  );
}
