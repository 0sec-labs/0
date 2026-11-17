import type { ConsoleMessageInput, ConsoleSessionSnapshot } from "@0/engine/shared";
import { reduceConversation } from "./transcript";

/** A message the person has sent that the server has not shown back yet. */
export interface OptimisticSend {
  id: string;
  sessionId: string;
  text: string;
  attachments?: ConsoleMessageInput["attachments"];
  queued: boolean;
  /** The server has it once it shows this many turns with the same text (or, for a queued one, this many queued messages). */
  expectedTurns: number;
  expectedQueued: number;
}

export const OPTIMISTIC_PREFIX = "optimistic-";
const ACTIVE = ["working", "waiting", "cancelling"];

const turnCount = (snapshot: ConsoleSessionSnapshot, text: string) =>
  reduceConversation(snapshot).filter((turn) => turn.user.text === text).length;

export function createOptimisticSend(shown: ConsoleSessionSnapshot, sessionId: string, input: ConsoleMessageInput): OptimisticSend {
  const queued = input.mode === "queue";
  return {
    id: `${OPTIMISTIC_PREFIX}${Math.random().toString(36).slice(2)}`,
    sessionId,
    text: input.text,
    attachments: input.attachments?.filter((item) => item.kind === "image"),
    queued,
    expectedTurns: turnCount(shown, input.text) + 1,
    expectedQueued: shown.queuedMessages.length + 1,
  };
}

function arrived(server: ConsoleSessionSnapshot, item: OptimisticSend) {
  if (item.queued) {
    // A queued message that already started shows up as a turn instead of staying queued.
    return server.queuedMessages.length >= item.expectedQueued || turnCount(server, item.text) >= item.expectedTurns;
  }
  return turnCount(server, item.text) >= item.expectedTurns;
}

export function settledSends(server: ConsoleSessionSnapshot, pending: OptimisticSend[]): OptimisticSend[] {
  return pending.filter((item) => arrived(server, item));
}

/** The thread as the person expects to see it: their just-sent messages are already there, in place, until the server confirms them. */
export function withOptimisticSends(server: ConsoleSessionSnapshot, sessionId: string, pending: OptimisticSend[]): ConsoleSessionSnapshot {
  const waiting = pending.filter((item) => item.sessionId === sessionId && !arrived(server, item));
  if (!waiting.length) return server;
  const sent = waiting.filter((item) => !item.queued);
  const queued = waiting.filter((item) => item.queued);
  return {
    ...server,
    messages: [
      ...server.messages,
      ...sent.map((item) => ({
        role: "user" as const,
        content: [
          ...(item.text ? [{ type: "text" as const, text: item.text }] : []),
          ...(item.attachments ?? []).flatMap((attachment) => {
            const match = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.value);
            return match ? [{ type: "image" as const, mediaType: match[1], data: match[2], name: attachment.name }] : [];
          }),
        ],
      })),
    ] as ConsoleSessionSnapshot["messages"],
    queuedMessages: [
      ...server.queuedMessages,
      ...queued.map((item) => ({ id: item.id, text: item.text, attachments: item.attachments, createdAt: new Date(0).toISOString() })),
    ],
    // The previous turn's outcome belongs to the previous turn; it must not paint over the new message.
    ...(sent.length ? { lastOutcome: null } : {}),
    session: sent.length && !ACTIVE.includes(server.session.status) ? { ...server.session, status: "working" as const } : server.session,
  };
}
