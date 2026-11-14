/** Pure model for the MCP and plugins page: validators, normalizers and list helpers. No DOM, no network. */

export type McpTransport = "stdio" | "http" | "sse";
export interface KeyValueRow { key: string; value: string }
export interface McpServerDraft {
  name: string; transport: McpTransport;
  command: string; args: string; cwd: string; env: KeyValueRow[];
  url: string; headers: KeyValueRow[];
}
export interface McpServerPayload {
  name: string; transport: McpTransport;
  command?: string; args?: string[]; cwd?: string; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
}
export interface McpToolInfo { name: string; description: string }

export const emptyMcpDraft = (): McpServerDraft => ({ name: "", transport: "stdio", command: "", args: "", cwd: "", env: [{ key: "", value: "" }], url: "", headers: [{ key: "", value: "" }] });

const LOADER_VARS = /^(?:LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|BASH_ENV|ENV|PERL5OPT|RUBYOPT)$/i;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const HEADER_PATTERN = /^[A-Za-z0-9-]+$/;

/** Splits a command-line style string into argv without invoking a shell: quotes group words, a backslash escapes the next character. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = ""; let quote: '"' | "'" | null = null; let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) current += text[++index];
      else current += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === "\\" && index + 1 < text.length) { current += text[++index]; started = true; }
    else if (/\s/.test(char)) { if (started || current) { out.push(current); current = ""; started = false; } }
    else { current += char; started = true; }
  }
  if (started || current) out.push(current);
  return out;
}

const needsQuote = (word: string) => word === "" || /[^A-Za-z0-9_@%+=:,./-]/.test(word);
const quoteWord = (word: string) => needsQuote(word) ? `"${word.replace(/(["\\])/g, "\\$1")}"` : word;
/** The exact command line a stdio server will be spawned with, shown before the user confirms. Environment values are never included. */
export function commandPreview(command: string, args: string[]): string { return [command.trim(), ...args].map(quoteWord).join(" "); }

const rowsToRecord = (rows: KeyValueRow[]) => Object.fromEntries(rows.filter(row => row.key.trim() !== "").map(row => [row.key.trim(), row.value]));

export interface McpValidation { ok: boolean; errors: Partial<Record<"name" | "command" | "url" | "env" | "headers" | "args" | "cwd", string>>; payload?: McpServerPayload }

/** Only http(s) URLs are accepted; credentials in the URL are rejected so secrets go through the write-only header rows. */
export function validateMcpDraft(draft: McpServerDraft): McpValidation {
  const errors: McpValidation["errors"] = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Enter a name."; else if (name.length > 60 || /[\u0000-\u001f]/.test(name)) errors.name = "Use up to 60 characters, without control characters.";
  const payload: McpServerPayload = { name, transport: draft.transport };
  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (!command) errors.command = "Enter the command to run."; else if (/\s|\0/.test(command)) errors.command = "Enter only the program here, such as npx. Put the rest in Arguments.";
    else if (command.length > 1024) errors.command = "The command is too long.";
    const args = splitArgs(draft.args);
    if (args.length > 64 || args.some(arg => arg.length > 4096 || arg.includes("\0"))) errors.args = "Use up to 64 arguments of 4096 characters.";
    const cwd = draft.cwd.trim();
    if (cwd && (cwd.startsWith("/") || cwd.startsWith("~") || /^[A-Za-z]:/.test(cwd) || cwd.split(/[\\/]/).includes("..") || cwd.includes("\0"))) errors.cwd = "Use a folder inside the workspace, relative to its root.";
    payload.command = command; payload.args = args; if (cwd) payload.cwd = cwd;
    const bad = draft.env.find(row => row.key.trim() !== "" && !KEY_PATTERN.test(row.key.trim()));
    const dup = new Set<string>(); let duplicate = false;
    for (const row of draft.env) { const key = row.key.trim(); if (!key) continue; if (dup.has(key)) duplicate = true; dup.add(key); }
    const loader = draft.env.find(row => LOADER_VARS.test(row.key.trim()));
    if (bad) errors.env = `"${bad.key.trim()}" is not a valid variable name.`; else if (loader) errors.env = `${loader.key.trim()} changes how programs load code and is not allowed.`; else if (duplicate) errors.env = "Each variable can be set once.";
    else if (draft.env.length > 64 || draft.env.some(row => row.value.length > 8192)) errors.env = "Use up to 64 variables of 8192 characters.";
    payload.env = rowsToRecord(draft.env);
  } else {
    const raw = draft.url.trim();
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") errors.url = "Use an https URL.";
      else if (url.username || url.password) errors.url = "Remove the username and password. Put credentials in a header.";
      else if (url.hash) errors.url = "Remove the # fragment.";
    } catch { errors.url = raw ? "Enter a full URL such as https://example.com/mcp." : "Enter the server URL."; }
    payload.url = raw;
    const bad = draft.headers.find(row => row.key.trim() !== "" && !HEADER_PATTERN.test(row.key.trim()));
    if (bad) errors.headers = `"${bad.key.trim()}" is not a valid header name.`;
    else if (draft.headers.some(row => /[\r\n]/.test(row.value))) errors.headers = "Header values must be a single line.";
    payload.headers = rowsToRecord(draft.headers);
  }
  const ok = Object.keys(errors).length === 0;
  return ok ? { ok, errors, payload } : { ok, errors };
}

/** Stable key for "has the form changed since the last successful test", so a confirm needs a test of exactly what will be saved. */
export const draftFingerprint = (draft: McpServerDraft) => JSON.stringify(validateMcpDraft(draft).payload ?? null);

export interface GithubRef { repo: string; ref: string }
/** Accepts `owner/name`, `owner/name@ref`, and github.com URLs (including /tree/<ref>). */
export function parseGithubRepo(input: string, refInput = ""): { value?: GithubRef; error?: string } {
  let text = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let ref = refInput.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^\s#?]+))?/i.exec(text);
  if (url) { text = `${url[1]}/${url[2]!.replace(/\.git$/, "")}`; if (!ref && url[3]) ref = decodeURIComponent(url[3]); }
  const at = text.indexOf("@");
  if (at > 0) { if (!ref) ref = text.slice(at + 1); text = text.slice(0, at); }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(text)) return { error: "Enter the repository as owner/name." };
  if (ref && (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(ref) || ref.includes(".."))) return { error: "That branch, tag or commit is not valid." };
  return { value: { repo: text, ref: ref || "HEAD" } };
}

export const isFullSha = (value: string) => /^[0-9a-f]{40}$/i.test(value);

/** Logos must be same-origin: a data: image or an absolute path on this origin. Anything remote is dropped so the CSP never blocks a request and nothing leaks. */
export function safeLogo(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const value = src.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif);base64,[A-Za-z0-9+/=]+$/i.test(value) && value.length <= 400_000) return value;
  if (/^\/(?![/\\])[A-Za-z0-9._~\-/%]+$/.test(value) && !value.includes("..")) return value;
  return undefined;
}

export const countLabel = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "MCP server · 4 tools · 2 skills"; counts are omitted when the server does not report them. */
export function entrySubtitle(kind: "MCP server" | "Plugin" | "Skill pack", counts: { tools?: number; skills?: number; extra?: string }): string {
  const parts: string[] = [kind];
  if (typeof counts.tools === "number") parts.push(countLabel(counts.tools, "tool"));
  if (typeof counts.skills === "number") parts.push(countLabel(counts.skills, "skill"));
  if (counts.extra) parts.push(counts.extra);
  return parts.join(" · ");
}

export function filterByText<T extends { name: string; description?: string }>(items: T[], text: string): T[] {
  const needle = text.trim().toLowerCase();
  return needle ? items.filter(item => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle)) : items;
}

/** Moves one id up or down. Out-of-range moves and unknown ids return the same array. */
export function moveId(order: string[], id: string, delta: -1 | 1): string[] {
  const from = order.indexOf(id); const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = order.slice(); next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}
/** Drops `id` and reinserts it before/after `target`. */
export function moveBefore(order: string[], id: string, target: string): string[] {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const without = order.filter(item => item !== id);
  without.splice(without.indexOf(target), 0, id);
  return without;
}
/** Applies a saved order to a list: known ids first in saved order, the rest keep their original relative order. */
export function applyOrder<T>(items: T[], idOf: (item: T) => string, saved: readonly string[] | undefined): T[] {
  if (!saved?.length) return items;
  const rank = new Map(saved.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index })).sort((a, b) => (rank.get(idOf(a.item)) ?? Infinity) - (rank.get(idOf(b.item)) ?? Infinity) || a.index - b.index).map(entry => entry.item);
}

export interface UsageBar { label: string; usedPercent: number; caption: string; breakdown: string[] }
const money = (value: number, currency: string) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); } catch { return `${value.toFixed(2)} ${currency}`; } };
/** Turns the backend's connection usage into one bar. Only a real credit limit produces a bar; "not exposed" or missing data returns null so the UI hides it rather than inventing numbers. */
export function usageBar(raw: unknown): UsageBar | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as { available?: unknown; window?: unknown };
  if (usage.available !== true || !usage.window || typeof usage.window !== "object") return null;
  const window = usage.window as Record<string, unknown>;
  const num = (key: string) => typeof window[key] === "number" && Number.isFinite(window[key]) ? window[key] as number : undefined;
  const limit = num("limit"); const remaining = num("remaining");
  if (limit === undefined || limit <= 0 || remaining === undefined) return null;
  const currency = typeof window.currency === "string" && /^[A-Z]{3}$/.test(window.currency) ? window.currency : "USD";
  const used = Math.max(0, limit - remaining);
  const breakdown = ([["today", "usedDaily"], ["this week", "usedWeekly"], ["this month", "usedMonthly"]] as const).flatMap(([label, key]) => { const value = num(key); return value === undefined ? [] : [`${money(value, currency)} ${label}`]; });
  return { label: "Credit limit", usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)), caption: `${money(used, currency)} of ${money(limit, currency)} used`, breakdown };
}

/** Per-model enablement: a model is on unless the saved list is present and omits it. */
export function modelEnabled(enabled: readonly string[] | undefined, id: string): boolean { return !enabled || enabled.includes(id); }
export function toggleModel(all: readonly string[], enabled: readonly string[] | undefined, id: string, on: boolean): string[] {
  const current = new Set(enabled ?? all);
  if (on) current.add(id); else current.delete(id);
  return all.filter(item => current.has(item));
}

export const SETUP_PROMPT = "Help me set up an MCP server or plugin for 0. Ask which service I want to connect, find its official MCP server or plugin and the install command, show me the exact command it would run on this machine and the permissions it needs, and wait for my confirmation before adding it. Never print or store secrets in chat; ask me to enter them in Settings > MCP & plugins.";
