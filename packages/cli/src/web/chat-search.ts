import { extractConversationText } from "../conversation-text.js";
import { matchConversation, searchConversations } from "../conversation-store.js";

export interface ChatSearchResult {
  id: string;
  savedId?: string;
  title: string;
  preview: string;
  updatedAt: string;
  archived: boolean;
  source: "live" | "saved";
  status?: string;
  relevance?: number;
}
export interface ChatSearchDocument extends Omit<ChatSearchResult, "preview"> { messages: readonly unknown[] }
/** Public text projection shared with model conversation history. */
export const chatText = extractConversationText;

export function matchChat(document: ChatSearchDocument, query: string): ChatSearchResult | null {
  const text = chatText(document.messages);
  if (!text.trim()) return null;
  const match = matchConversation({ session: { id: document.id, savedAt: 0, cwd: "", preview: "", messageCount: document.messages.length }, title: document.title, text }, query);
  if (!match) return null;
  const { messages: _messages, ...result } = document;
  return { ...result, title: match.title, preview: match.preview, relevance: match.score };
}

export function compareChatSearchResults(a: ChatSearchResult, b: ChatSearchResult): number {
  return (b.relevance ?? 0) - (a.relevance ?? 0) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Saved UI and model search share the canonical reader, matching and ranking. */
export async function searchSavedChats(homeDir: string | undefined, query: string, excluded: ReadonlySet<string>) {
  const result = await searchConversations({ homeDir, query, excludedIds: excluded });
  const results: ChatSearchResult[] = result.conversations.filter(match => match.text.trim()).map(match => ({
    id: match.session.id, title: match.title, preview: match.preview,
    updatedAt: new Date(Math.min(8.64e15, Math.max(-8.64e15, match.session.savedAt))).toISOString(),
    archived: match.session.archived === true, source: "saved", relevance: match.score,
  }));
  return { results, truncated: result.truncated };
}
