import { isLocalAdmissionFailure } from "../../runtime/request-admission.js";
import type { NativeRuntime, NativeMessage, NativeContentBlock, NativeRuntimeResult } from "../../runtime/types.js";
import { features } from "../features.js";
import { currentRunContribution } from "../../telemetry/run-contribution.js";

// ── Context Window Compaction (BoxPwnr-style) ──
// When the conversation grows too large, replace middle messages with a summary
// while preserving critical ones (credentials, flags, findings) and the tail.

/** Patterns that indicate a message contains critical information worth preserving verbatim. */
const CRITICAL_PATTERNS = [
  /flag/i, /password/i, /credentials?/i, /cookie/i, /token/i,
  /session/i, /admin/i, /root/i, /\/etc\/passwd/i, /save_finding/i,
  /secret/i, /api[_-]?key/i, /bearer/i, /jwt/i,
];

/**
 * Critical-message regex used by `compactMessagesWithLLM` to decide which
 * middle messages to preserve verbatim alongside the LLM summary, gated
 * behind `features.preserveCriticalMessages` (0#229, BoxPwnr-inspired).
 *
 * Tuned to high-signal tokens that survive paraphrasing poorly — the
 * literal credential string is what matters, not the model's recap of it.
 */
export const CRITICAL_MESSAGE_PATTERNS =
  /\b(password|credential|root|shell|access gained|vulnerability|exploit successful|key found|login|authenticated)\b/i;

/** Patterns for extracting noteworthy lines from tool results for the summary. */
const SUMMARY_EXTRACT_PATTERNS = [
  /flag\{[^}]*\}/i, /password[\s:="]+\S+/i, /token[\s:="]+\S+/i,
  /cookie[\s:="]+\S+/i, /secret[\s:="]+\S+/i, /api[_-]?key[\s:="]+\S+/i,
  /HTTP\/\d\.\d\s+\d{3}/i, /status[\s:]+\d{3}/i,
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/,
  /\/[\w/.-]{3,}/, // file paths / URL paths
  /error|denied|forbidden|unauthorized|success|found|vulnerable/i,
  /save_finding/i,
  /admin|root|sudo/i,
];

function serializeMessageToText(msg: NativeMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_use") parts.push(`${block.name}(${JSON.stringify(block.input)})`);
    else if (block.type === "tool_result") parts.push(block.content);
  }
  return parts.join("\n");
}

function isCriticalMessage(msg: NativeMessage): boolean {
  const text = serializeMessageToText(msg);
  return CRITICAL_PATTERNS.some((p) => p.test(text));
}

function extractKeyFindings(messages: NativeMessage[]): string {
  const findings: string[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content) {
      // Extract from tool results (where most useful info lives)
      const text = block.type === "tool_result"
        ? block.content
        : block.type === "text"
          ? block.text
          : block.type === "tool_use"
            ? `${block.name}: ${JSON.stringify(block.input)}`
            : "";

      if (!text) continue;

      // For save_finding calls, capture the whole thing
      if (block.type === "tool_use" && block.name === "save_finding") {
        const entry = `FINDING: ${JSON.stringify(block.input)}`;
        if (!seen.has(entry)) {
          seen.add(entry);
          findings.push(entry);
        }
        continue;
      }

      // Extract matching lines from tool output
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length > 500) continue;
        if (SUMMARY_EXTRACT_PATTERNS.some((p) => p.test(trimmed))) {
          if (!seen.has(trimmed)) {
            seen.add(trimmed);
            findings.push(trimmed);
          }
        }
      }
    }
  }

  // Cap the summary so it doesn't bloat the context
  return findings.slice(0, 80).join("\n");
}

/** Default compaction trigger + regrow, in prompt tokens. */
export const DEFAULT_COMPACTION_THRESHOLD = 77_000;
export const DEFAULT_COMPACTION_REGROW = 30_000;

/**
 * Resolve the compaction thresholds from the environment so an operator can tune
 * them to the model's real context window (there is no context-window catalog to
 * derive a fraction from). `ZERO_COMPACTION_THRESHOLD` sets when compaction
 * fires; `ZERO_COMPACTION_REGROW` sets how much new context must accrue before it
 * fires again. Both are clamped to sane positive floors; a malformed value falls
 * back to the default. Pure — the env is passed in.
 */
export function resolveCompactionThresholds(
  env: Record<string, string | undefined> = {},
): { threshold: number; regrow: number } {
  const parse = (raw: string | undefined, fallback: number, floor: number): number => {
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= floor ? Math.floor(n) : fallback;
  };
  return {
    threshold: parse(env["ZERO_COMPACTION_THRESHOLD"], DEFAULT_COMPACTION_THRESHOLD, 1_000),
    regrow: parse(env["ZERO_COMPACTION_REGROW"], DEFAULT_COMPACTION_REGROW, 500),
  };
}

/**
 * The scan loop's summarizer instruction (security-testing framing). Kept as
 * the DEFAULT so the autonomous scan loop's behavior is unchanged when it calls
 * `compactMessagesWithLLM` without an explicit `summarizerInstruction`. The
 * console loop passes a general-purpose instruction instead (see turn-engine).
 */
export const SCAN_SUMMARIZER_INSTRUCTION =
  `Summarize this security testing conversation. Preserve ALL:\n- URLs and endpoints discovered\n- Credentials, tokens, cookies, API keys found\n- Technologies and frameworks identified\n- Vulnerabilities found or suspected\n- Attack attempts and their results (success/failure)\n- Any flags or partial flags seen\n- OPEN todo/plan items and the current objective/phase (what is still in progress and what to do next)\n- Payloads/commands that worked, so they need not be re-derived\n\nBe concise but complete. Use bullet points.`;

/** Options bag for {@link compactMessagesWithLLM}. All optional; the defaults
 * reproduce the scan loop's original behavior exactly. */
export class ContextSummaryReceiptError extends Error {
  constructor(message: string, readonly unpriced: boolean) { super(message); this.name = "ContextSummaryReceiptError"; }
}
export interface CompactMessagesOptions {
  /** Local admission recovery requires a successful metered summary, never a fallback after an unknown outcome. */
  requireSummaryReceipt?: boolean;
  /** How many trailing messages to preserve verbatim. Default 10. */
  preserveTailCount?: number;
  /**
   * The summarizer's user-facing instruction (the part BEFORE the serialized
   * conversation). Defaults to {@link SCAN_SUMMARIZER_INSTRUCTION}. When
   * supplied, a GENERIC summarizer system prompt is used instead of the
   * scan loop's security-testing one.
   */
  summarizerInstruction?: string;
  /** Invoked with the summarizer model call's usage, when the runtime reports it. */
  onSummaryUsage?: (usage: NonNullable<NativeRuntimeResult["usage"]>) => void;
  /** Shares cancellation with the planner; late summaries never rewrite history. */
  signal?: AbortSignal;
}

/** Result of {@link compactMessagesWithLLM}. */
export interface CompactMessagesResult {
  /** The rebuilt (compacted) message array — or the input unchanged when there
   * was too little to compact. */
  messages: NativeMessage[];
  /** The `[COMPACTED CONVERSATION SUMMARY]` body produced (empty when nothing
   * was compacted). */
  summaryText: string;
  /** True when the LLM summary threw or was too short and it fell back to regex
   * extraction / hard-trim. */
  degraded: boolean;
}

/**
 * Compact the conversation using LLM-based summarization.
 *
 * Approach (BoxPwnr-inspired):
 * 1. Serialize all middle messages (between first prompt and last N turns) to text
 * 2. Ask the LLM to produce a concise technical summary (preserving creds, endpoints, findings)
 * 3. Rebuild conversation: [system + initial prompt] → [assistant ack] → [user: summary] → [tail]
 *
 * Falls back to regex-based extraction if LLM summarization fails (`degraded`).
 *
 * Returns `{ messages, summaryText, degraded }`. The scan loop reads `.messages`
 * and default opts keep its summarizer instruction / tail count unchanged; the
 * console loop passes a general-purpose instruction and reads `summaryText` +
 * `degraded` for its compaction event.
 */
export async function compactMessagesWithLLM(
  messages: NativeMessage[],
  runtime: NativeRuntime,
  systemPrompt: string,
  opts: CompactMessagesOptions = {},
): Promise<CompactMessagesResult> {
  void systemPrompt;
  if (opts.signal?.aborted) return { messages, summaryText: "", degraded: false };
  const preserveTailCount = opts.preserveTailCount ?? 10;
  const summarizerInstruction = opts.summarizerInstruction ?? SCAN_SUMMARIZER_INSTRUCTION;
  const summarizerSystem = opts.summarizerInstruction === undefined
    ? "You are a concise technical summarizer for a security testing conversation."
    : "You are a concise, thorough technical summarizer.";

  if (messages.length <= preserveTailCount + 2) {
    return { messages, summaryText: "", degraded: false }; // not enough messages to compact
  }

  const firstMessage = messages[0]!;
  let tailStart = messages.length - preserveTailCount;
  if (opts.requireSummaryReceipt) {
    // Extra user warnings can follow a tool result. Keep the complete latest
    // assistant/call + result exchange, not a fixed two-message suffix.
    while (tailStart > 1 && messages[tailStart]!.role !== "assistant") tailStart--;
    if (messages[tailStart]?.role !== "assistant") return { messages, summaryText: "", degraded: false };
  }
  const tail = messages.slice(tailStart);
  const middle = messages.slice(1, tailStart);

  // Serialize middle messages for summarization
  const fullConversationText = middle
    .map((m) => {
      const prefix = m.role === "assistant" ? "[Assistant]" : "[Tool Output]";
      return `${prefix}\n${serializeMessageToText(m)}`;
    })
    .join("\n\n");
  if (fullConversationText.length > 50_000) currentRunContribution()?.record("truncation", { reason: "compaction_input", originalChars: fullConversationText.length, retainedChars: 50_000 });
  const conversationText = fullConversationText.slice(0, 50_000);

  // Also extract regex findings as fallback / supplement
  const regexFindings = extractKeyFindings(middle);

  // Try LLM summarization
  let summaryText: string;
  let degraded = false;
  let summaryUsageObserved = false;
  try {
    const summaryResult = await runtime.executeNative(
      summarizerSystem,
      [
        {
          role: "user",
          content: [{
            type: "text",
            text: `${summarizerInstruction}\n\nCONVERSATION:\n${conversationText}`,
          }],
        },
      ],
      [], // no tools for summary
      undefined,
      opts.signal,
    );

    if (summaryResult.usage) {
      summaryUsageObserved = true;
      opts.onSummaryUsage?.(summaryResult.usage);
    }
    if (opts.signal?.aborted) {
      if (opts.requireSummaryReceipt && !summaryUsageObserved && !isLocalAdmissionFailure(summaryResult.error)) {
        throw new Error(summaryResult.error ?? "Context summary cancelled without a usage receipt");
      }
      return { messages, summaryText: "", degraded: false };
    }
    if (summaryResult.stopReason !== "end_turn" || summaryResult.error) throw new Error(summaryResult.error ?? "Incomplete context summary");
    if (opts.requireSummaryReceipt && !summaryResult.usage) throw new Error("Context summary did not report usage; cannot continue admission recovery");

    // Extract text from result
    const textBlocks = summaryResult.content.filter(
      (b): b is NativeContentBlock & { type: "text" } => b.type === "text",
    );
    summaryText = textBlocks.map((b) => b.text).join("\n");

    if (!summaryText || summaryText.length < 50) {
      throw new Error("LLM summary too short or empty");
    }
  } catch (error) {
    if (opts.requireSummaryReceipt) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ContextSummaryReceiptError(message, !summaryUsageObserved && !isLocalAdmissionFailure(message));
    }
    if (opts.signal?.aborted) return { messages, summaryText: "", degraded: false };
    // Fallback to regex extraction
    degraded = true;
    summaryText = [
      "## Scan Progress Summary (compacted)",
      "",
      `Compacted ${middle.length} messages.`,
      "",
      "### Key findings, credentials, endpoints:",
      regexFindings || "(no findings extracted)",
    ].join("\n");
  }

  // Append regex findings that may have been missed by LLM
  if (regexFindings) {
    summaryText += `\n\n### Additional extracted context:\n${regexFindings}`;
  }

  // 0#229: append credential / exploit-bearing middle messages verbatim,
  // because LLM paraphrasing routinely drops the literal string
  // ("Found admin password: hunter2" → "discovered admin credentials"), which
  // breaks long-tail challenges where the agent recovers a credential early
  // and needs to type it back exactly later. BoxPwnr-inspired (see
  // single_loop_compactation.py in 0ca/BoxPwnr).
  if (features.preserveCriticalMessages) {
    const preserved: string[] = [];
    for (const msg of middle) {
      const text = serializeMessageToText(msg);
      if (CRITICAL_MESSAGE_PATTERNS.test(text)) {
        const prefix = msg.role === "assistant" ? "[Assistant]" : "[Tool Output]";
        preserved.push(`${prefix}\n${text}`);
      }
    }
    if (preserved.length > 0) {
      summaryText += `\n\n### Preserved verbatim (credential / exploit-bearing turns):\n${preserved.join("\n\n")}`;
    }
  }

  // Rebuild with correct role alternation
  const compacted: NativeMessage[] = [firstMessage];

  compacted.push({
    role: "assistant",
    content: [{ type: "text", text: "I have been working on this scan. Here is my progress so far." }],
  });

  compacted.push({
    role: "user",
    content: [{ type: "text", text: `[COMPACTED CONVERSATION SUMMARY]\n\n${summaryText}\n\nPlease continue from where we left off. What should we try next?` }],
  });

  // Append the tail, ensuring correct role alternation
  let tailIdx = 0;
  while (tailIdx < tail.length && tail[tailIdx]!.role !== "assistant") {
    tailIdx++;
  }

  let lastRole: "user" | "assistant" = "user";
  for (let i = tailIdx; i < tail.length; i++) {
    const msg = tail[i]!;
    if (msg.role === lastRole) {
      // MERGE the same-role run, never drop it. The loop injects extra user
      // messages routinely — loot, playbooks, loop warnings, budget warnings —
      // so consecutive user messages are normal, and the one being dropped was
      // often the `tool_result`-bearing message, i.e. the answer to the tool
      // call the assistant just made. Dropping it also orphans that call.
      compacted[compacted.length - 1] = mergeSameRole(compacted[compacted.length - 1]!, msg);
      continue;
    }
    compacted.push(msg);
    lastRole = msg.role;
  }

  return { messages: compacted, summaryText, degraded };
}

/**
 * Concatenate two same-role messages into one.
 *
 * `providerRaw` (the opaque reasoning sidecar) survives only when both sides
 * carry one from the same provider+model+wireApi — concatenating the two raw
 * arrays keeps each one's internal ordering, so every reasoning item is still
 * immediately followed by the item it produced. When only one side has it the
 * sidecar is DROPPED: replaying it verbatim would skip the other message's
 * content entirely, and falling back to reconstruction is the safe direction.
 */
function mergeSameRole(a: NativeMessage, b: NativeMessage): NativeMessage {
  const merged: NativeMessage = { role: a.role, content: [...a.content, ...b.content] };
  const rawA = a.providerRaw;
  const rawB = b.providerRaw;
  if (
    rawA && rawB
    && rawA.provider === rawB.provider
    && rawA.model === rawB.model
    && rawA.wireApi === rawB.wireApi
  ) {
    merged.providerRaw = { ...rawA, output: [...rawA.output, ...rawB.output] };
  }
  return merged;
}

/**
 * Last-resort overflow recovery: preserve the opening task and recent tail,
 * explicitly mark the removed middle, and normalize tail role alternation.
 *
 * This intentionally runs only after a provider rejects the request for its
 * context window. Normal growth uses `compactMessagesWithLLM`, which preserves
 * more evidence through a summary; this path trades detail for a bounded retry.
 */
export function dropOldestMessages(
  messages: NativeMessage[],
  preserveTailCount = 10,
): NativeMessage[] {
  if (messages.length <= preserveTailCount + 3) return messages;

  const first = messages[0]!;
  const tail = messages.slice(Math.max(1, messages.length - preserveTailCount));
  const compacted: NativeMessage[] = [
    first,
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "Earlier conversation context was pruned after a provider context-window rejection.",
      }],
    },
    {
      role: "user",
      content: [{
        type: "text",
        text: `[CONTEXT OVERFLOW RECOVERY] Dropped ${messages.length - tail.length - 1} older messages. Continue from the preserved recent context.`,
      }],
    },
  ];

  let tailIndex = 0;
  while (tailIndex < tail.length && tail[tailIndex]!.role !== "assistant") {
    tailIndex++;
  }

  let lastRole: "user" | "assistant" = "user";
  for (let index = tailIndex; index < tail.length; index++) {
    const message = tail[index]!;
    if (message.role === lastRole) {
      compacted[compacted.length - 1] = mergeSameRole(
        compacted[compacted.length - 1]!,
        message,
      );
      continue;
    }
    compacted.push(message);
    lastRole = message.role;
  }
  return compacted;
}

// ── Progress Summary Generation ──
// When early-stop triggers, ask the LLM to produce a structured summary of what
// was tried and discovered so the retry attempt can skip dead ends. Similar to
// BoxPwnr's --generate-progress / --resume-from pattern.

export async function generateProgressSummary(
  messages: NativeMessage[],
  runtime: NativeRuntime,
): Promise<string> {
  // Serialize all messages into a conversation transcript for the summarizer
  const fullConversationText = messages
    .map((m) => {
      const prefix = m.role === "assistant" ? "[Assistant]" : "[Tool Output]";
      return `${prefix}\n${serializeMessageToText(m)}`;
    })
    .join("\n\n");
  if (fullConversationText.length > 60_000) currentRunContribution()?.record("truncation", { reason: "progress_summary_input", originalChars: fullConversationText.length, retainedChars: 60_000 });
  const conversationText = fullConversationText.slice(0, 60_000);

  const summaryResult = await runtime.executeNative(
    "You are a concise technical summarizer for a security penetration testing session.",
    [
      {
        role: "user",
        content: [{
          type: "text",
          text: `A penetration testing agent has an unfinished investigation without saved vulnerabilities. Summarize its progress into a structured handoff document so a DIFFERENT agent can continue without repeating the same work.

Your summary MUST include these sections (use exactly these headings). If a section has no items, write "None found." under it.

### Endpoints/URLs Discovered
List every URL, path, and API endpoint the agent interacted with, along with HTTP status codes and notable response characteristics.

### Vulnerabilities Tested & Results
For each vulnerability class tested (SQLi, XSS, SSTI, IDOR, path traversal, command injection, etc.), list:
- What specific payloads/techniques were tried
- What the result was (blocked, reflected, error, no effect)
- Any partial progress or promising leads

### Credentials/Tokens/Cookies Found
Any authentication material discovered (usernames, passwords, tokens, session cookies, API keys, JWTs).

### Failed Approaches & Why
What strategies were tried and definitively ruled out? Why did they fail? (e.g., "WAF blocks all <script> tags", "CSRF tokens rotate per-request")

### Remaining Untried Approaches
Based on what was discovered, what attack vectors have NOT been attempted yet? What looks most promising?

CONVERSATION:
${conversationText}`,
        }],
      },
    ],
    [], // no tools for summary
  );

  const textBlocks = summaryResult.content.filter(
    (b): b is NativeContentBlock & { type: "text" } => b.type === "text",
  );
  const summary = textBlocks.map((b) => b.text).join("\n");

  if (!summary || summary.length < 50) {
    throw new Error("Progress summary too short or empty");
  }

  return summary;
}
