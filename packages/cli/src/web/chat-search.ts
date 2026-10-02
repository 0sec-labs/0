import { open, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { isValidSessionId, sessionsDir } from "../tui/session-store.js";

export interface ChatSearchResult {
  id: string;
  savedId?: string;
  title: string;
  preview: string;
  updatedAt: string;
  archived: boolean;
  source: "live" | "saved";
  status?: string;
}
export interface ChatSearchDocument extends Omit<ChatSearchResult, "preview"> { messages: readonly unknown[] }
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const line = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();

/** Index conversational text only. Tool arguments, results, reasoning and metadata stay out. */
export function chatText(messages: readonly unknown[]): string {
  let text = "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const raw = message as Record<string, unknown>;
    if (raw.role !== "user" && raw.role !== "assistant") continue;
    const content = typeof raw.content === "string" ? [raw.content] : Array.isArray(raw.content)
      ? raw.content.flatMap(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : []) : [];
    for (const part of content) {
      text += `${part.slice(0, MAX_TEXT - text.length)}\n`;
      if (text.length >= MAX_TEXT) return text.slice(0, MAX_TEXT);
    }
  }
  return text;
}

export function matchChat(document: ChatSearchDocument, query: string): ChatSearchResult | null {
  const text = line(chatText(document.messages));
  // A prepared workspace or tool-only record is not a searchable conversation.
  if (!text) return null;
  const recordedTitle = line(document.title).slice(0, 200);
  const title = !recordedTitle || /^(new chat|untitled chat)$/i.test(recordedTitle) ? text.slice(0, 120) : recordedTitle;
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searchable = `${title}\n${text}`.toLocaleLowerCase();
  if (!terms.every(term => searchable.includes(term))) return null;
  const start = terms.length ? Math.max(0, text.toLocaleLowerCase().indexOf(terms[0]!) - 40) : 0;
  const preview = `${start ? "…" : ""}${text.slice(start, start + 180)}${text.length > start + 180 ? "…" : ""}`;
  const { messages: _messages, ...result } = document;
  return { ...result, title, preview };
}

/** Async bounded disk reads keep history searches from blocking active turns. */
export async function searchSavedChats(homeDir: string | undefined, query: string, excluded: ReadonlySet<string>) {
  const dir = sessionsDir(homeDir);
  const results: ChatSearchResult[] = [];
  let truncated = false;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { results, truncated }; }
  const candidates = entries.filter(entry => entry.isFile() && entry.name.endsWith(".json") && isValidSessionId(entry.name.slice(0, -5)) && !excluded.has(entry.name.slice(0, -5)));
  // Retention normally keeps far fewer entries; don't read arbitrarily many hostile local files.
  if (candidates.length > MAX_FILES) truncated = true;
  const files = await Promise.all(candidates.slice(0, MAX_FILES).map(async entry => {
    try { const info = await stat(join(dir, entry.name)); return { name: entry.name, size: info.size, modified: info.mtimeMs }; } catch { return null; }
  }));
  const ordered = files.filter(file => file !== null).sort((a, b) => b.modified - a.modified);
  let bytes = 0;
  for (const file of ordered) {
    if (file.size > MAX_FILE_BYTES || bytes + file.size > MAX_READ_BYTES) { truncated = true; continue; }
    bytes += file.size;
    let handle;
    try {
      handle = await open(join(dir, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      // Bounded buffer also handles a file growing between stat and read.
      const buffer = Buffer.alloc(file.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > file.size) { truncated = true; continue; }
      const raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.messages)) continue;
      const timestamp = typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt) ? raw.savedAt : 0;
      const title = typeof raw.consoleState?.title === "string" ? raw.consoleState.title : typeof raw.summary === "string" ? raw.summary : typeof raw.preview === "string" ? raw.preview : "Untitled chat";
      const result = matchChat({ id: file.name.slice(0, -5), title, updatedAt: new Date(timestamp).toISOString(), archived: raw.archived === true, source: "saved", messages: raw.messages }, query);
      if (result) results.push(result);
    } catch { /* A corrupt or concurrently removed transcript cannot break search. */ }
    finally { await handle?.close(); }
  }
  return { results, truncated };
}
