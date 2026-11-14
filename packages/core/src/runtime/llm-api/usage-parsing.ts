import { type RuntimeResult, type NativeContentBlock } from "../types.js";
import { type WireBlock } from "../prompt-cache.js";

/**
 * Explicit output bound used on every provider route that accepts one.
 * ChatGPT Codex OAuth rejects an explicit Responses cap; callers that require
 * a hard monetary ceiling must reject that route before making a request.
 */
export const NATIVE_COMPLETION_TOKEN_LIMIT = 8192;
/**
 * Read `usage.input_tokens_details.cached_tokens` off a Responses payload.
 *
 * Returns `{}` when the provider does not report it, so spreading the result
 * never plants an explicit `undefined` on the usage object. Unlike Anthropic,
 * the Responses API counts cached tokens INSIDE `input_tokens`, so this is
 * observability only — no re-adding, no double counting.
 */
export function readResponsesCachedTokens(usage: Record<string, unknown>): { cachedInputTokens?: number } {
  const details = usage.input_tokens_details as Record<string, unknown> | undefined;
  const cached = Number(details?.cached_tokens ?? 0);
  return Number.isFinite(cached) && cached > 0 ? { cachedInputTokens: cached } : {};
}
export function readChatUsage(raw: unknown): RuntimeResult["usage"] {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  if (usage.prompt_tokens === undefined && usage.completion_tokens === undefined) return undefined;
  return {
    inputTokens: Number(usage.prompt_tokens ?? 0), outputTokens: Number(usage.completion_tokens ?? 0),
    ...readResponsesCachedTokens({ input_tokens_details: usage.prompt_tokens_details }),
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
