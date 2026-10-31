import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanConversationText, extractConversationText } from "./conversation-text.js";
import { isValidSessionId, sessionsDir, storedSessionMetadata, type StoredSessionMeta } from "./tui/session-store.js";

export interface ConversationDocument { session: StoredSessionMeta; title: string; text: string }
export interface ConversationMatch extends ConversationDocument { preview: string; score: number }
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const line = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();

/** The same matcher serves live chats, saved UI search and model history tools. */
export function matchConversation(document: ConversationDocument, query: string): ConversationMatch | null {
  const text = line(document.text);
  const recordedTitle = line(cleanConversationText(document.title)).slice(0, 200);
  const title = !recordedTitle || /^(new chat|untitled chat)$/i.test(recordedTitle) ? text.slice(0, 120) : recordedTitle;
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const metadata = [document.session.id, document.session.cwd, document.session.target, document.session.preview, document.session.summary]
    .map(value => value ? cleanConversationText(value) : "").join("\n").toLocaleLowerCase();
  const searchableTitle = title.toLocaleLowerCase();
  const searchableText = text.toLocaleLowerCase();
  const searchable = `${searchableTitle}\n${metadata}\n${searchableText}`;
  if (!terms.every(term => searchable.includes(term))) return null;
  const position = terms.map(term => searchableText.indexOf(term)).find(index => index >= 0) ?? 0;
  const start = Math.max(0, position - 40);
  const preview = `${start ? "…" : ""}${text.slice(start, start + 180)}${text.length > start + 180 ? "…" : ""}`;
  const score = terms.reduce((sum, term) => sum + (searchableTitle.includes(term) ? 3 : 0) + (metadata.includes(term) ? 2 : 0) + (searchableText.includes(term) ? 1 : 0), 0);
  return { ...document, title, preview, score };
}

/** One bounded, asynchronous reader for the canonical saved transcripts. */
export async function searchConversations(options: { homeDir?: string; cwd?: string; excludedIds?: ReadonlySet<string>; query?: string } = {}) {
  const dir = sessionsDir(options.homeDir);
  const conversations: ConversationMatch[] = [];
  let truncated = false;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { conversations, truncated }; }
  const candidates = entries.filter(entry => entry.isFile() && entry.name.endsWith(".json") && isValidSessionId(entry.name.slice(0, -5)) && !options.excludedIds?.has(entry.name.slice(0, -5)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length > MAX_FILES) truncated = true;
  const files = await Promise.all(candidates.slice(0, MAX_FILES).map(async entry => {
    try { const info = await stat(join(dir, entry.name)); return { name: entry.name, modified: info.mtimeMs }; } catch { return null; }
  }));
  const ordered = files.filter(file => file !== null).sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  let bytes = 0;
  for (const file of ordered) {
    let handle;
    try {
      handle = await open(join(dir, file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      // An atomic save may replace the path after the ordering stat. Size and
      // read budgets must describe the file we actually opened.
      if (!info.isFile() || info.size > MAX_FILE_BYTES || bytes + info.size > MAX_READ_BYTES) { truncated = true; continue; }
      bytes += info.size;
      const buffer = Buffer.alloc(info.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > info.size) { truncated = true; continue; }
      const raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.messages)) continue;
      const session = storedSessionMetadata(file.name.slice(0, -5), raw, raw.messages.length);
      if (options.cwd !== undefined && session.cwd !== options.cwd) continue;
      const title = typeof raw.consoleState?.title === "string" ? raw.consoleState.title : session.summary ?? session.preview;
      const match = matchConversation({ session, title: cleanConversationText(title), text: extractConversationText(raw.messages) }, options.query ?? "");
      if (match) conversations.push(match);
    } catch { /* A corrupt or concurrently removed transcript cannot break history. */ }
    finally { try { await handle?.close(); } catch { /* Keep partial history usable. */ } }
  }
  conversations.sort((a, b) => b.score - a.score || b.session.savedAt - a.session.savedAt || a.session.id.localeCompare(b.session.id));
  return { conversations, truncated };
}
