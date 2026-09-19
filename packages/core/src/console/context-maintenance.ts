import type { NativeMessage, NativeRuntime, NativeToolDef } from "../runtime/types.js";

export const SUMMARY_MARKER = "[COMPACTED CONVERSATION SUMMARY]";
type Usage = { inputTokens: number; outputTokens: number };

/** Conservative local estimate, including schemas and opaque provider history. */
export function estimatePromptTokens(system: string, messages: NativeMessage[], tools: NativeToolDef[] = []): number {
  return Math.ceil((system.length + JSON.stringify(messages).length + JSON.stringify(tools).length) / 3);
}

export function outputHeadroom(outputLimit?: number): number {
  // Match the native API's default completion ceiling. Some runtimes (including
  // Codex subscriptions) cannot advertise a provider-enforced output limit.
  return outputLimit && Number.isFinite(outputLimit) && outputLimit > 0 ? outputLimit : 8192;
}

/** Do not mistake entitlement/transport failures mentioning context for overflow. */
export function contextOverflow(error: unknown): boolean {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): string => {
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (!value || typeof value !== "object" || depth > 3 || seen.has(value)) return "";
    seen.add(value);
    // SDK metadata matters; stacks and raw request payloads do not classify an error.
    const record = value as Record<string, unknown>;
    return ["message", "name", "code", "type", "status", "statusCode", "error", "cause", "response", "data"]
      .map((key) => describe(record[key], depth + 1)).join(" ");
  };
  const text = describe(error, 0);
  if (/quota|rate.?limit|too many requests|unauth|authentication|permission|forbidden|insufficient|\b(?:401|403|429|5\d\d)\b/i.test(text)) return false;
  return /context[_ -]?(?:length|window|limit)|maximum context|too many tokens|(?:prompt|input).{0,30}(?:too long|too large)|exceed.{0,30}context/i.test(text);
}

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n[context maintenance: omitted middle; tool already executed]\n";
  if (limit <= marker.length) return text.slice(0, Math.max(0, limit));
  const half = Math.max(0, Math.floor((limit - marker.length) / 2));
  return text.slice(0, half) + marker + text.slice(-half);
}

/** Only split at complete exchanges. Malformed/resuming partial history is left alone. */
function pairedGroups(messages: NativeMessage[]): NativeMessage[][] | undefined {
  const groups: NativeMessage[][] = [];
  const pending = new Set<string>();
  let group: NativeMessage[] = [];
  for (const message of messages) {
    group.push(message);
    for (const block of message.content) {
      if (block.type === "tool_use") pending.add(block.id);
      if (block.type === "tool_result" && !pending.delete(block.tool_use_id)) return undefined;
    }
    if (!pending.size) { groups.push(group); group = []; }
  }
  return pending.size ? undefined : groups;
}

export interface MaintenanceResult {
  messages: NativeMessage[];
  summaryText: string;
  degraded: boolean;
  budgetBlocked?: boolean;
  cancelled?: boolean;
  /** Non-context provider failures are terminal, never a reason to retry. */
  error?: unknown;
}

/**
 * Propose a smaller history without mutating the live array. Keep the anchor,
 * latest operator instruction and complete recent exchanges. Recovery may
 * abbreviate tool output, but never changes a tool id or re-executes a tool.
 */
export async function maintainContext(opts: {
  messages: NativeMessage[];
  latestUserMessage?: NativeMessage;
  runtime: NativeRuntime;
  instruction: string;
  preserveTail: number;
  toolOutputLimit?: number;
  allowLossy: boolean;
  window?: number;
  remainingTokens: number;
  signal?: AbortSignal;
  onUsage: (usage: Usage) => void;
}): Promise<MaintenanceResult> {
  const unchanged: MaintenanceResult = { messages: opts.messages, summaryText: "", degraded: true };
  if (opts.signal?.aborted) return { ...unchanged, cancelled: true };
  const groups = pairedGroups(opts.messages);
  if (!groups?.length) return unchanged;
  const latestInstruction = opts.latestUserMessage ?? [...opts.messages].reverse().find((m) => m.role === "user"
    && m.content.some((b) => b.type === "text" && !b.text.startsWith(SUMMARY_MARKER)));
  const tail = new Set<NativeMessage>();
  let tailSize = 0;
  for (const group of [...groups].reverse()) {
    if (tailSize >= opts.preserveTail) break;
    for (const message of group) tail.add(message);
    tailSize += group.length;
  }
  const removed: NativeMessage[] = [];
  const kept: NativeMessage[] = [];
  const abbreviated: NativeMessage[] = [];
  for (const group of groups) {
    const protect = group.includes(opts.messages[0]!) || (latestInstruction && group.includes(latestInstruction));
    if (!protect && !group.some((m) => tail.has(m))) { removed.push(...group); continue; }
    for (const message of group) {
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== "tool_result" || !opts.toolOutputLimit || block.content.length <= opts.toolOutputLimit) return block;
        changed = true;
        return { ...block, content: excerpt(block.content, opts.toolOutputLimit) };
      });
      if (changed) abbreviated.push(message);
      // A raw provider sidecar must never replay content removed from a block.
      kept.push(changed ? { role: message.role, content } : message);
    }
  }
  if (!removed.length && !abbreviated.length) return unchanged;
  const system = "You are a concise, thorough technical summarizer.";
  const source = [...removed, ...abbreviated];
  const reserve = outputHeadroom(opts.runtime.outputTokenLimit);
  const charBudget = Math.max(0, Math.min(50_000, ((opts.window ?? 32_000) - reserve) * 3 - system.length - opts.instruction.length - 300));
  // Allocate space across all removed messages, including the previous summary.
  const perMessage = Math.floor(charBudget / source.length);
  const serialized = source.map((m) => excerpt(JSON.stringify(m), perMessage)).join("\n");
  const summaryMessages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: `${opts.instruction}\n\nCONVERSATION:\n${serialized}` }] }];
  const inputEstimate = estimatePromptTokens(system, summaryMessages);
  if (inputEstimate + reserve > opts.remainingTokens) return { ...unchanged, budgetBlocked: true };
  let summaryText = "";
  let failure: unknown;
  let streamed: Usage | undefined;
  try {
    const result = await opts.runtime.executeNative(system, summaryMessages, [], {
      onUsage: (usage) => { streamed = usage; },
    }, opts.signal);
    summaryText = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    opts.onUsage(result.usage ?? streamed ?? { inputTokens: inputEstimate, outputTokens: Math.ceil(summaryText.length / 3) });
    if (opts.signal?.aborted || result.cancelled) return { ...unchanged, cancelled: true };
    if (result.stopReason === "error") failure = result.error ?? "Summarizer failed";
    else if (summaryText.length < 50) summaryText = "";
  } catch (error) {
    opts.onUsage(streamed ?? { inputTokens: inputEstimate, outputTokens: 0 });
    if (opts.signal?.aborted) return { ...unchanged, cancelled: true };
    failure = error;
  }
  if (failure && !contextOverflow(failure)) return { ...unchanged, error: failure };
  if (failure) summaryText = "";
  const degraded = !summaryText;
  if (degraded && !opts.allowLossy) return unchanged;
  if (degraded) {
    // Retain the previous summary on the lossy path, rather than discarding
    // the only surviving record of the older task's progress.
    summaryText = removed.flatMap((m) => m.content.flatMap((b) => b.type === "text" && b.text.startsWith(SUMMARY_MARKER) ? [b.text] : [])).join("\n");
    summaryText += "\n[Context overflow recovery: older exchanges/output omitted. Tools in this history have already executed; continue from the retained results.]";
  }
  const summary: NativeMessage = { role: "user", content: [{ type: "text", text: `${SUMMARY_MARKER}\n${summaryText}` }] };
  // Insert only after the complete anchor exchange, never between tool pairs.
  const anchorLength = groups[0]!.length;
  const rebuilt = [...kept.slice(0, anchorLength), summary, ...kept.slice(anchorLength)];
  const before = estimatePromptTokens("", opts.messages);
  // Tiny textual changes are not useful headroom and must not re-arm a loop.
  if (before - estimatePromptTokens("", rebuilt) < Math.max(16, Math.floor(before * 0.01))) return unchanged;
  return { messages: rebuilt, summaryText, degraded };
}
