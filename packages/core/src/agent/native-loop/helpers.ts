import { isLocalAdmissionFailure } from "../../runtime/request-admission.js";
import { randomUUID } from "node:crypto";
import type { NativeRuntime, NativeMessage, NativeToolDef, NativeRuntimeResult } from "../../runtime/types.js";
import type { ToolResult, ToolResultMeta } from "../types.js";
import { type CompactMessagesOptions, compactMessagesWithLLM, dropOldestMessages } from "./compaction.js";

// ── External Memory ──
// The agent can persist working state (creds, endpoints, attack plans) to this
// file via bash. At reflection checkpoints the contents are injected back into
// the conversation so the agent doesn't lose track of discoveries.
export function externalMemoryPath(scanId?: string): string {
  return `/tmp/0-state-${scanId ?? randomUUID()}.json`;
}

// ── Loot harvesting (0#567) ──
// Tools whose result text reflects target data worth mining for footholds.
// Network, file, browser, and MCP tools surface target data; shell tools are
// included because they routinely shell out to curl / cat and surface the same kind of
// credentials, tokens, and paths. Our own trusted bookkeeping tools
// (save_finding / query_findings / use_loot / done) are deliberately excluded
// — save_finding harvests via its own evidence path in the executor.
export function shouldHarvestLoot(toolName: string): boolean {
  return (
    ["http_request", "crawl", "read_file", "send_prompt", "submit_form", "browser"].includes(toolName) ||
    toolName.startsWith("mcp__") ||
    toolName === "bash" ||
    toolName === "run_command" ||
    // js_eval / python_eval shell out to node / python3 (which routinely curl,
    // read files, and print tokens/paths), exactly like bash — mine their
    // output for footholds too.
    toolName === "js_eval" ||
    toolName === "python_eval"
  );
}

// ── Reasoning summary heuristic ──
// The agent-trace dashboard renders a short preview of what the model was
// thinking on each turn. We derive a 1-line summary from the streamed
// thinking text using a cheap, deterministic heuristic:
//
//   1. If any line begins with `Thought:` / `Reasoning:` / `Plan:`
//      (case-insensitive, with optional surrounding whitespace/markdown),
//      take the first sentence of the remainder of that line.
//   2. Otherwise, take the first sentence of the whole thinking text.
//   3. Collapse whitespace and truncate to ~140 chars.
//   4. Return "" for empty/unusable input — callers skip emit on empty.
//
// Exported for unit tests.
const REASONING_PREFIX_RE =
  // Each repetition starts with a non-whitespace marker, fixing its boundary.
  // foxguard: ignore[js/no-unsafe-regex]
  /^\s*(?:[*_>#-]\s*)*(?:thought|reasoning|plan)\s*:\s*/i;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;
const REASONING_MAX_LEN = 140;

export function summarizeReasoning(thinkingText: string | undefined | null): string {
  if (!thinkingText) return "";

  // Normalize whitespace FIRST — newlines / tabs / repeat spaces all collapse
  // to single spaces. This lets the prefix regex work regardless of how the
  // runtime wrapped the thinking text, and gives the sentence splitter clean
  // input.
  const normalized = String(thinkingText).replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  // Strip the prefix if one is present — work on the content after it.
  const candidate = normalized.replace(REASONING_PREFIX_RE, "").trim();
  if (!candidate) return "";

  // First sentence only (split on `.` / `!` / `?` followed by whitespace).
  const firstSentence = candidate.split(SENTENCE_SPLIT_RE)[0] ?? candidate;
  const trimmed = firstSentence.trim();
  if (!trimmed) return "";

  if (trimmed.length <= REASONING_MAX_LEN) return trimmed;
  // Truncate with an ellipsis so downstream renderers see clean boundaries.
  return trimmed.slice(0, REASONING_MAX_LEN - 1).trimEnd() + "…";
}


export const EXTERNAL_MEMORY_MAX_CHARS = 2000;

/**
 * Classify transient provider overloads, rate limits and transport failures
 * for the agent loop's bounded same-turn retry. Includes the runtime's own
 * per-call timeout, which `LlmApiRuntime` reports as
 * "<provider> API request timed out" rather than a transport code.
 */
export function isTransientLlmError(errorMsg: string): boolean {
  if (isNonReplayableLlmError(errorMsg)) return false;
  return /\b(429|529|502|503|504)\b|overloaded|rate.?limit|temporarily|too many requests|ETIMEDOUT|ECONNRESET|throttl|stall|API request timed out/i.test(errorMsg);
}

function isNonReplayableLlmError(errorMsg: string): boolean {
  return /automatic replay (?:is )?disabled|outcome.{0,30}unknown|unresolved_inference_charge|recovery_requires_review|settlement_ambiguous|usage_settlement_unconfirmed/i.test(errorMsg);
}

/**
 * Provider context-window rejection classifier. Pruning changes the next
 * request; rate limits and generic 5xx never prune history.
 */
export function isContextWindowError(errorMsg: string): boolean {
  if (isLocalAdmissionFailure(errorMsg) || isNonReplayableLlmError(errorMsg)) return false;
  if (/\bAPI error 429:/i.test(errorMsg)) return false;
  return /context.{0,40}(?:window|length|limit)|(?:maximum|max).{0,20}context|too many tokens|prompt.{0,30}(?:too long|too large)|input.{0,30}(?:too long|too large|limit(?:_exceeded)?)/i.test(
    errorMsg,
  );
}

/**
 * Keep the request assembled by the engine below the managed inference
 * gateway's 256 kB admission ceiling. Provider adapters add framing after
 * this check, so retain 25% headroom rather than aiming at the hard limit.
 */
export const NATIVE_REQUEST_PREFLIGHT_BYTES = 192 * 1024;

/** A generic completion signal must not replace this invocation's actual assistant prose. */
export function isInformativeDoneText(text: string): boolean {
  return !!text.trim() && !/^task completed[.!]?$/i.test(text.trim());
}
export function resolveDoneSummary(summary: unknown, assistantText: string): string {
  if (typeof summary === "string" && isInformativeDoneText(summary)) return summary.trim();
  if (isInformativeDoneText(assistantText)) return assistantText.trim();
  return typeof summary === "string" && summary.trim() ? summary.trim() : "Task completed";
}

export function estimateNativeRequestBytes(
  systemPrompt: string,
  messages: NativeMessage[],
  tools: NativeToolDef[],
): number {
  return Buffer.byteLength(JSON.stringify({ system: systemPrompt, messages, tools }), "utf8")
    + 1024
    + 64 * (messages.length + tools.length);
}

/**
 * Compact before dispatch when a large tool result makes the next request too
 * large. Token-based compaction runs after a completed turn and cannot prevent
 * this boundary failure. If summarization is still too large, preserve the
 * opening task and successively smaller recent tails.
 */
export async function compactMessagesForRequestPreflight(
  messages: NativeMessage[],
  runtime: NativeRuntime,
  systemPrompt: string,
  tools: NativeToolDef[],
  byteLimit = NATIVE_REQUEST_PREFLIGHT_BYTES,
  opts: CompactMessagesOptions = {},
): Promise<{ messages: NativeMessage[]; compacted: boolean; degraded: boolean }> {
  if (estimateNativeRequestBytes(systemPrompt, messages, tools) <= byteLimit) {
    return { messages, compacted: false, degraded: false };
  }

  const summarized = await compactMessagesWithLLM(messages, runtime, systemPrompt, opts);
  let next = summarized.messages;
  let degraded = summarized.degraded;
  if (estimateNativeRequestBytes(systemPrompt, next, tools) <= byteLimit) {
    return { messages: next, compacted: true, degraded };
  }

  for (const tailCount of [6, 3, 1]) {
    const pruned = dropOldestMessages(next, tailCount);
    if (pruned === next) continue;
    next = pruned;
    degraded = true;
    if (estimateNativeRequestBytes(systemPrompt, next, tools) <= byteLimit) break;
  }
  if (estimateNativeRequestBytes(systemPrompt, next, tools) > byteLimit) {
    throw new Error(
      `inference request remains above the ${byteLimit}-byte preflight limit after context compaction`,
    );
  }
  return { messages: next, compacted: true, degraded };
}

/** Total extra output-cap requests permitted in one loop/console turn. */
export const MAX_OUTPUT_CAP_CONTINUATIONS = 3;
export const OUTPUT_CAP_CONTINUATION_PROMPT =
  "[OUTPUT CAP CHECKPOINT] The previous response reached max_output_tokens. Continue from the retained observations and current plan, without restarting the task or repeating completed tools. No function calls from that incomplete response were executed; if still needed, issue them anew as complete calls. Keep the remaining answer concise.";

/** Only the runtime's observation-only checkpoint authorizes a new request. */
export function isRecoverableOutputCap(result: NativeRuntimeResult): boolean {
  return result.stopReason === "max_tokens" && result.checkpoint?.reason === "max_output_tokens" &&
    !result.error && !result.cancelled && !result.providerRaw &&
    result.content.every(block => block.type === "text");
}

/**
 * Fold a command-tool's captured exit status + output tail into a single
 * concise line, e.g. `exited 1: <last lines of stdout/stderr>`. Used to
 * enrich a failure string when the display sidecar {@link ToolResultMeta}
 * carries process detail (exit code / timeout / combined stdout+stderr) that
 * the bare `error` string would otherwise drop. Returns "" when the meta has
 * nothing worth reporting.
 */
function formatExitSummary(meta: ToolResultMeta | undefined): string {
  if (!meta) return "";
  let prefix = "";
  if (meta.timedOut) prefix = meta.timeoutMs ? `timed out after ${meta.timeoutMs}ms` : "timed out";
  else if (typeof meta.exitCode === "number") prefix = `exited ${meta.exitCode}`;
  else if (meta.exitCode === null) prefix = "killed before exit";
  // Tail of the combined stdout/stderr: the operator/model wants the END of
  // the output (where the failure message usually is), not the head.
  const out = (meta.stdout ?? "").trim();
  let tail = "";
  if (out) {
    const lines = out.split("\n").slice(-8);
    tail = lines.join("\n");
    if (tail.length > 600) tail = "…" + tail.slice(tail.length - 600);
  }
  if (prefix && tail) return `${prefix}: ${tail}`;
  return prefix || tail;
}

/**
 * Guarantee a NON-EMPTY, informative failure string for a `success:false`
 * {@link ToolResult}. Never returns a bare "unknown". Precedence:
 *   1. the real `error` message (the thrown Error's message survives here);
 *   2. a command-meta exit summary folded in when the sidecar carries process
 *      detail the bare string dropped (`exited N: <output tail>`);
 *   3. a generic-but-named fallback that at least says WHICH tool failed, so
 *      the operator never sees a context-free word again.
 *
 * Exported for tests.
 */
export function toolFailureText(toolName: string, result: ToolResult): string {
  const base = typeof result.error === "string" ? result.error.trim() : "";
  const exitSummary = formatExitSummary(result.meta);
  if (base && exitSummary && !base.includes(exitSummary)) return `${base} (${exitSummary})`;
  if (base) return base;
  if (exitSummary) return exitSummary;
  return `${toolName} failed without an error message`;
}
