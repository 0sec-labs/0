import { redactSensitiveHeaders } from "@0/core";
import type { StoredSessionMeta } from "./tui/session-store.js";
import { sanitizeComposerText } from "./tui/text.js";

/** Shared public-history projection. Raw transcripts remain private replay data. */
export function cleanConversationText(value: string): string {
  return redactSensitiveHeaders(sanitizeComposerText(value))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private key redacted]")
    .replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[credential redacted]")
    .replace(/((?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|password|secret)|authorization|cookie)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[redacted]");
}

export function conversationMessageText(message: unknown): { role: "user" | "assistant"; text: string } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const row = message as { role?: unknown; content?: unknown };
  if (row.role !== "user" && row.role !== "assistant") return undefined;
  const text = typeof row.content === "string" ? row.content : Array.isArray(row.content)
    ? row.content.flatMap(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n")
    : "";
  return text ? { role: row.role, text: cleanConversationText(text) } : undefined;
}

/** Include only user/assistant prose, with a bounded searchable projection. */
export function extractConversationText(messages: readonly unknown[], maxChars = 1_000_000): string {
  let text = "";
  for (const message of messages) {
    const row = conversationMessageText(message);
    if (!row) continue;
    text += `${row.text.slice(0, maxChars - text.length)}\n`;
    if (text.length >= maxChars) return text.slice(0, maxChars);
  }
  return text;
}

export function publicConversationMetadata(session: StoredSessionMeta) {
  return {
    id: session.id, savedAt: session.savedAt,
    cwd: cleanConversationText(session.cwd).slice(0, 512),
    target: session.target ? cleanConversationText(session.target).slice(0, 256) : undefined,
    model: session.model ? cleanConversationText(session.model).slice(0, 128) : undefined,
    messageCount: session.messageCount,
    preview: cleanConversationText(session.preview),
    summary: session.summary ? cleanConversationText(session.summary) : undefined,
  };
}
