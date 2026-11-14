import { VISUALIZE_TOOL } from "./visuals";
import { toolCallStatus } from "./tool-call-status";
import { needsModelSourceReconnect, needsProviderSignIn } from "./provider-error";
import type { ReducedTurn, ToolCallState } from "./transcript";

/** "5m 16s" or "12s"; undefined when the turn has no usable clock. */
export function formatElapsed(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function failedCallCount(calls: readonly ToolCallState[]): number {
  return calls.filter((call) => toolCallStatus(call) === "Error").length;
}

export interface WorkedMarkers {
  failed: number;
  subagents: number;
  compacted: boolean;
}

/** Trailing markers after "Worked for 12s": ", 1 failed, 2 subagents, compacted". */
export function workedMarkers({ failed, subagents, compacted }: WorkedMarkers): string[] {
  return [
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(subagents > 0 ? [`${subagents} ${subagents === 1 ? "subagent" : "subagents"}`] : []),
    ...(compacted ? ["compacted"] : []),
  ];
}

export function workedLabel(input: {
  isWorking: boolean;
  hasWork: boolean;
  stopped: boolean;
  time: string;
  markers: WorkedMarkers;
}): string {
  const base = input.isWorking
    ? input.hasWork
      ? "Working"
      : "Thinking"
    : input.stopped
      ? "Stopped"
      : "Worked";
  const head = !input.isWorking && input.time ? `${base} for ${input.time}` : base;
  return [head, ...workedMarkers(input.markers)].join(", ");
}

/**
 * The newest assistant message must be readable in full; only history is clamped.
 * `lastAssistantOfTurn` is that segment's position, `latestTurn` whether the turn is the newest one.
 */
export function clampDisabled(input: { latestTurn: boolean; isLastAssistantSegment: boolean }): boolean {
  return input.latestTurn && input.isLastAssistantSegment;
}

/** Successful `visualize` calls render inline as a card, so their work row would only repeat it. */
export function hideFromWorkLog(call: ToolCallState, hasVisuals: boolean): boolean {
  return hasVisuals && call.name === VISUALIZE_TOOL && toolCallStatus(call) === "Done";
}

/** Policy, approval and scope refusals are not transient: resending the same message cannot succeed. */
export function isRetryableError(error: string): boolean {
  if (needsProviderSignIn(error) || needsModelSourceReconnect(error)) return false;
  return !/approval|approve|declined|denied|policy|out of scope|scope (?:violation|check|policy)|not allowed|forbidden|permission|blocked by|cancel/i.test(
    error,
  );
}

export type MessageRole = "user" | "assistant";

export interface ToolbarActions {
  copy: boolean;
  reply: boolean;
  copyMarkdown: boolean;
  copyLink: boolean;
  /** The engine has no edit or rewind-and-resend API, so these never appear. */
  edit: false;
  retryFromHere: false;
}

export function toolbarActions(input: { text: string; canReply: boolean; hasLink: boolean }): ToolbarActions {
  const hasText = input.text.trim().length > 0;
  return {
    copy: hasText,
    reply: hasText && input.canReply,
    copyMarkdown: hasText,
    copyLink: input.hasLink,
    edit: false,
    retryFromHere: false,
  };
}

/** Quote a message as a markdown block, ready to prefix the composer draft. */
export function quoteBlock(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

/** Plain-text copy: markdown syntax removed, code and link text kept. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .trim();
}

export function messageLink(href: string, turnId: string): string {
  return `${href.split("#")[0]}#chat-${turnId}`;
}

export type TurnArtifact = {
  id: string;
  kind: "finding" | "pull-request";
  title: string;
  status: string;
  /** Present for pull requests; findings open the Findings panel view. */
  url?: string;
};

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Tool receipts wrap the payload as `{ success: true, output }` (possibly JSON-encoded). */
function unwrapReceipt(value: unknown): unknown {
  let data = parse(value);
  for (let depth = 0; depth < 4 && data && typeof data === "object" && !Array.isArray(data); depth++) {
    const receipt = data as Record<string, unknown>;
    if (receipt.success === true && Object.hasOwn(receipt, "output")) data = parse(receipt.output);
    else break;
  }
  return data;
}

function findPrUrl(value: unknown, depth = 0): string | undefined {
  const data = parse(value);
  if (!data || typeof data !== "object" || depth > 5) return undefined;
  for (const [key, child] of Object.entries(data as Record<string, unknown>)) {
    if (key === "prUrl" && typeof child === "string" && /^https:\/\/\S+\/pull\/\d+/.test(child)) return child;
    const nested = findPrUrl(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export function prNumber(url: string): string {
  const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[2]}#${match[3]}` : url;
}

/** Findings saved and pull requests recorded by this turn's successful tool results; nothing is inferred. */
export function turnArtifacts(turn: Pick<ReducedTurn, "toolCalls">): TurnArtifact[] {
  const found = new Map<string, TurnArtifact>();
  for (const call of turn.toolCalls) {
    if (toolCallStatus(call) !== "Done") continue;
    const result = unwrapReceipt(call.result);
    if (call.name === "save_finding" && result && typeof result === "object") {
      const id = (result as Record<string, unknown>).findingId;
      const args = parse(call.arguments);
      const title = args && typeof args === "object" ? (args as Record<string, unknown>).title : undefined;
      if (typeof id === "string" && id && !found.has(`finding:${id}`))
        found.set(`finding:${id}`, {
          id,
          kind: "finding",
          title: typeof title === "string" && title.trim() ? title.trim() : `Finding ${id}`,
          status: "Saved",
        });
    }
    const url = findPrUrl(result);
    if (url && !found.has(`pr:${url}`))
      found.set(`pr:${url}`, { id: url, kind: "pull-request", title: `Opened ${prNumber(url)}`, status: "PR opened", url });
  }
  return [...found.values()];
}
