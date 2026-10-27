import type { ConsoleConversationHistory } from "@0/core";
import { searchConversations } from "./conversation-store.js";
import { conversationMessageText, publicConversationMetadata } from "./conversation-text.js";
import { isValidSessionId, loadSession } from "./tui/session-store.js";

const MAX_PAGE_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 4_000;

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("limit must be an integer from 1 to 100");
  return value;
}

/** Reads the same store as /sessions; never exposes provider payloads or tool results. */
export function createConversationHistory(options: { cwd?: string; homeDir?: string } = {}): ConsoleConversationHistory {
  const cwd = options.cwd ?? process.cwd();
  return {
    async list({ query, allProjects, limit }) {
      const count = pageLimit(limit);
      if (query !== undefined && (typeof query !== "string" || query.length > 256)) throw new Error("Invalid conversation search query");
      if (allProjects !== undefined && typeof allProjects !== "boolean") throw new Error("allProjects must be a boolean");
      const result = await searchConversations({ homeDir: options.homeDir, cwd: allProjects ? undefined : cwd, query });
      const matches = result.conversations.map(match => ({
        ...publicConversationMetadata(match.session),
        ...(query?.trim() ? { preview: match.preview || publicConversationMetadata(match.session).preview } : {}),
      }));
      return { conversations: matches.slice(0, count), total: matches.length, hasMore: matches.length > count, truncated: result.truncated };
    },
    read({ sessionId, offset = 0, limit }) {
      const count = pageLimit(limit);
      if (!isValidSessionId(sessionId)) throw new Error("Invalid saved conversation ID");
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
      const session = loadSession(sessionId, options.homeDir);
      if (!session) throw new Error(`Saved conversation ${sessionId} was not found or could not be read`);
      const messages: Array<{ index: number; role: "user" | "assistant"; text: string; truncated: boolean }> = [];
      let remaining = MAX_PAGE_CHARS;
      let next = Math.min(offset, session.messages.length);
      const end = Math.min(session.messages.length, next + count);
      for (; next < end && remaining > 0; next++) {
        const row = conversationMessageText(session.messages[next]);
        if (!row) continue;
        const clean = row.text;
        const budget = Math.min(remaining, MAX_MESSAGE_CHARS);
        const clipped = clean.slice(0, budget);
        messages.push({ index: next, role: row.role, text: clipped, truncated: clean.length > budget });
        remaining -= clipped.length;
      }
      return {
        ...publicConversationMetadata(session),
        messages,
        offset,
        totalMessages: session.messages.length,
        nextOffset: next < session.messages.length ? next : null,
      };
    },
  };
}
