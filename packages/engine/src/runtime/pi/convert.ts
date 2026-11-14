/**
 * Pure converters between our Anthropic-style native blocks and pi-ai's
 * message model. No I/O, no pi runtime imports (types only) so this file is
 * cheap to load and trivially unit-testable.
 *
 * Known lossy spots (documented, see PiAiRuntime report):
 *  - Thinking text / signatures are NOT representable in `NativeContentBlock`.
 *    They travel in `NativeMessage.providerRaw` (the existing opaque, identity
 *    bound sidecar) and are replayed verbatim only when provider+api+model
 *    match AND the visible blocks were not edited since (compaction safe).
 *    Otherwise the assistant turn is rebuilt from visible blocks and thinking
 *    is dropped - exactly what pi itself does across a model switch.
 *  - Tool-result content is a string (ours) <-> text part (pi). Images inside
 *    tool results are not representable on our side.
 *  - A tool_result whose tool_use id is unknown cannot become a pi
 *    `toolResult` (needs a toolName / matching call); it is demoted to a user
 *    text part so the information survives and the request stays valid.
 *  - `ToolCall.argumentsError` (streamed JSON that never parsed) is kept as
 *    pi's best-effort `arguments`; the error text is returned in
 *    {@link PiConvertResult.argumentErrors} rather than hidden.
 */
import type {
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Message,
  StopReason,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  NativeContentBlock,
  NativeMessage,
  NativeRuntimeResult,
  NativeToolDef,
  ProviderRawOutput,
} from "../types.js";

/** Identity a provider-raw sidecar is bound to. */
export interface PiTargetIdentity {
  /** pi provider id, e.g. "anthropic". */
  provider: string;
  /** pi wire API, e.g. "anthropic-messages". */
  api: string;
  model: string;
}

/** `ProviderRawOutput.provider` prefix so a pi sidecar can never be mistaken for a Responses one. */
export const PI_RAW_PROVIDER_PREFIX = "pi-ai:";

export function piRawIdentity(target: PiTargetIdentity): Pick<ProviderRawOutput, "provider" | "model" | "wireApi"> {
  return { provider: `${PI_RAW_PROVIDER_PREFIX}${target.provider}`, model: target.model, wireApi: target.api };
}

type PiAssistantBlock = AssistantMessage["content"][number];

function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function toPiTools(tools: readonly NativeToolDef[]): Tool[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.input_schema }));
}

function toImage(block: Extract<NativeContentBlock, { type: "image" }>): ImageContent {
  return { type: "image", data: block.data, mimeType: block.mediaType };
}

function visibleText(blocks: readonly NativeContentBlock[]): string {
  return blocks.filter((b): b is Extract<NativeContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
}

function toolUseIds(blocks: readonly NativeContentBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
}

/** The raw pi blocks, only when bound to `target` and still consistent with the visible blocks. */
function replayableRaw(message: NativeMessage, target: PiTargetIdentity): PiAssistantBlock[] | undefined {
  const raw = message.providerRaw;
  if (!raw) return undefined;
  const id = piRawIdentity(target);
  if (raw.provider !== id.provider || raw.model !== id.model || raw.wireApi !== id.wireApi) return undefined;
  if (!Array.isArray(raw.output)) return undefined;
  const blocks = raw.output.filter((b): b is PiAssistantBlock =>
    typeof b === "object" && b !== null && ["text", "thinking", "toolCall"].includes((b as { type?: unknown }).type as string));
  if (blocks.length !== raw.output.length) return undefined;
  const rawToolIds = blocks.flatMap((b) => (b.type === "toolCall" ? [b.id] : []));
  const nativeIds = toolUseIds(message.content);
  if (rawToolIds.length !== nativeIds.length || rawToolIds.some((x, i) => x !== nativeIds[i])) return undefined;
  const rawText = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  if (rawText !== visibleText(message.content)) return undefined;
  return blocks;
}

function assistantToPi(message: NativeMessage, target: PiTargetIdentity, timestamp: number): AssistantMessage | undefined {
  const raw = replayableRaw(message, target);
  let content: PiAssistantBlock[];
  if (raw) {
    content = raw;
  } else {
    content = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.length > 0) content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({ type: "toolCall", id: block.id, name: block.name, arguments: (block.input ?? {}) as JsonObject });
      }
      // Images / tool_result on an assistant turn are not valid; dropped.
    }
  }
  if (content.length === 0) return undefined;
  const hasCalls = content.some((b) => b.type === "toolCall");
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.model,
    usage: zeroUsage(),
    stopReason: hasCalls ? "toolUse" : "stop",
    timestamp,
  };
}

/**
 * Our history -> pi `Context`. `timestamp` is stamped monotonically so replays
 * are deterministic (pi only uses it for ordering/diagnostics).
 */
export function toPiContext(
  system: string,
  messages: readonly NativeMessage[],
  tools: readonly NativeToolDef[],
  target: PiTargetIdentity,
  baseTimestamp = 0,
): Context {
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "tool_use") toolNames.set(b.id, b.name);
  }
  const out: Message[] = [];
  let ts = baseTimestamp;
  for (const m of messages) {
    if (m.role === "assistant") {
      const converted = assistantToPi(m, target, ++ts);
      if (converted) out.push(converted);
      continue;
    }
    const results: ToolResultMessage[] = [];
    const parts: Array<TextContent | ImageContent> = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const name = toolNames.get(b.tool_use_id);
        if (name === undefined) {
          parts.push({ type: "text", text: `[tool result for unknown call ${b.tool_use_id}${b.is_error ? " (error)" : ""}]\n${b.content}` });
        } else {
          results.push({
            role: "toolResult",
            toolCallId: b.tool_use_id,
            toolName: name,
            content: [{ type: "text", text: b.content }],
            isError: b.is_error === true,
            timestamp: ++ts,
          });
        }
      } else if (b.type === "text") {
        if (b.text.length > 0) parts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        parts.push(toImage(b));
      }
      // tool_use on a user turn is invalid; dropped.
    }
    // Tool results must directly follow the assistant turn that issued them.
    out.push(...results);
    if (parts.length > 0) {
      const user: UserMessage = { role: "user", content: parts, timestamp: ++ts };
      out.push(user);
    }
  }
  return { systemPrompt: system, messages: out, ...(tools.length > 0 ? { tools: toPiTools(tools) } : {}) };
}

export function mapPiStopReason(reason: StopReason, hasToolCalls: boolean): NativeRuntimeResult["stopReason"] {
  switch (reason) {
    case "toolUse": return "tool_use";
    case "length": return "max_tokens";
    case "stop": return hasToolCalls ? "tool_use" : "end_turn";
    default: return "error"; // error | aborted | pending | deferred
  }
}

/**
 * pi `Usage.input` EXCLUDES cache reads/writes (verified for every api module);
 * our `inputTokens` is the TOTAL prompt (see `readCacheUsage`).
 */
export function mapPiUsage(usage: Usage): NonNullable<NativeRuntimeResult["usage"]> {
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  return {
    inputTokens: (usage.input || 0) + cacheRead + cacheWrite,
    outputTokens: usage.output || 0,
    ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

export interface PiConvertResult {
  content: NativeContentBlock[];
  thinking: string;
  providerRaw?: ProviderRawOutput;
  /** tool_use id -> pi `argumentsError` for calls whose streamed JSON never parsed. */
  argumentErrors: Record<string, string>;
}

function needsRaw(block: PiAssistantBlock): boolean {
  if (block.type === "thinking") return true;
  if (block.type === "text") return block.textSignature !== undefined;
  return block.thoughtSignature !== undefined || block.namespace !== undefined;
}

/** pi assistant message -> our blocks (+ the opaque sidecar when something would otherwise be lost). */
export function fromPiAssistant(message: AssistantMessage, target: PiTargetIdentity): PiConvertResult {
  const content: NativeContentBlock[] = [];
  const argumentErrors: Record<string, string> = {};
  let thinking = "";
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall") {
      const call: ToolCall = block;
      content.push({ type: "tool_use", id: call.id, name: call.name, input: (call.arguments ?? {}) as Record<string, unknown> });
      if (call.argumentsError) argumentErrors[call.id] = call.argumentsError;
    } else if (block.type === "thinking") {
      // Redacted thinking has no readable text; only the raw sidecar keeps it.
      if (!block.redacted) thinking += block.thinking;
    }
  }
  const providerRaw: ProviderRawOutput | undefined = message.content.some(needsRaw)
    ? { ...piRawIdentity(target), output: JSON.parse(JSON.stringify(message.content)) as unknown[] }
    : undefined;
  return { content, thinking: thinking.trim(), argumentErrors, ...(providerRaw ? { providerRaw } : {}) };
}
