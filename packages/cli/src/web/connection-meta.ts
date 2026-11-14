import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "@0/engine/shared";
import { loadAccountStore, type AccountRecord, type AccountStore } from "../state/credential-store.js";

/**
 * Non-secret per-connection preferences: label, order, spread, disabled models.
 * Lives next to (never inside) the credential store; contains no credentials.
 * A connection id is `<providerId>:<accountId>`.
 */
interface AccountMeta { label?: string; disabledModels?: string[] }
interface ProviderMeta { order?: string[]; spread?: boolean; cursor?: string; accounts?: Record<string, AccountMeta> }
export interface ConnectionMeta { version: 1; providers: Record<string, ProviderMeta> }

const FILE = "connection-meta.json";
const SAFE = (key: string) => key.length > 0 && key !== "__proto__" && key !== "constructor" && key !== "prototype";
export class ConnectionMetaError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const bad = (message: string, code = "invalid_input") => new ConnectionMetaError(400, code, message);

export function loadConnectionMeta(homeDir?: string): ConnectionMeta {
  const meta: ConnectionMeta = { version: 1, providers: Object.create(null) as Record<string, ProviderMeta> };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(homeStateDir(homeDir), FILE), "utf8")); } catch { return meta; }
  const providers = raw && typeof raw === "object" ? (raw as { providers?: unknown }).providers : undefined;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return meta;
  for (const [providerId, value] of Object.entries(providers)) {
    if (!SAFE(providerId) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>; const out: ProviderMeta = {};
    if (Array.isArray(row.order)) out.order = row.order.filter((id): id is string => typeof id === "string" && SAFE(id)).slice(0, 64);
    if (typeof row.spread === "boolean") out.spread = row.spread;
    if (typeof row.cursor === "string" && SAFE(row.cursor)) out.cursor = row.cursor;
    if (row.accounts && typeof row.accounts === "object" && !Array.isArray(row.accounts)) {
      out.accounts = Object.create(null) as Record<string, AccountMeta>;
      for (const [accountId, a] of Object.entries(row.accounts)) {
        if (!SAFE(accountId) || !a || typeof a !== "object" || Array.isArray(a)) continue;
        const item: AccountMeta = {}; const entry = a as Record<string, unknown>;
        if (typeof entry.label === "string" && entry.label.length <= 80) item.label = entry.label;
        if (Array.isArray(entry.disabledModels)) item.disabledModels = entry.disabledModels.filter((m): m is string => typeof m === "string" && m.length <= 256).slice(0, 2048);
        out.accounts[accountId] = item;
      }
    }
    meta.providers[providerId] = out;
  }
  return meta;
}
export function saveConnectionMeta(meta: ConnectionMeta, homeDir?: string): void {
  const directory = homeStateDir(homeDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const path = join(directory, FILE); const temporary = join(directory, `.connection-meta-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, JSON.stringify(meta) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  catch { throw new ConnectionMetaError(500, "persistence_failed", "Could not save connection preferences."); }
  finally { rmSync(temporary, { force: true }); }
}

/** Saved accounts in operator order (unlisted accounts keep store order after the listed ones). */
export function orderedAccountIds(store: AccountStore, meta: ConnectionMeta, providerId: string): string[] {
  const ids = Object.keys(store.providers[providerId]?.accounts ?? {});
  const order = meta.providers[providerId]?.order ?? [];
  return [...order.filter(id => ids.includes(id)), ...ids.filter(id => !order.includes(id))];
}

/**
 * REAL spread behaviour. For every provider with spread on and 2+ saved accounts, advance a persisted
 * round-robin cursor and return a store whose active account is the next one. Called once per NEW
 * runtime creation, never for read-only views; live chats keep their captured connection.
 */
export function applySpread(store: AccountStore, homeDir?: string): AccountStore {
  const meta = loadConnectionMeta(homeDir);
  let result = store; let changed = false;
  for (const [providerId, provider] of Object.entries(meta.providers)) {
    if (!provider.spread) continue;
    const ids = orderedAccountIds(store, meta, providerId);
    if (ids.length < 2) continue;
    const previous = provider.cursor === undefined ? -1 : ids.indexOf(provider.cursor);
    const next = ids[(previous + 1) % ids.length]!;
    provider.cursor = next; changed = true;
    const entry = result.providers[providerId]!;
    result = { ...result, providers: { ...result.providers, [providerId]: { ...entry, activeAccountId: next } } };
  }
  if (changed) { try { saveConnectionMeta(meta, homeDir); } catch { /* rotation is best effort */ } }
  return result;
}

export function disabledModelsFor(providerId: string, store: AccountStore, homeDir?: string): Set<string> {
  const accountId = store.providers[providerId]?.activeAccountId;
  return new Set(accountId ? loadConnectionMeta(homeDir).providers[providerId]?.accounts?.[accountId]?.disabledModels ?? [] : []);
}
export function isModelDisabled(disabled: ReadonlySet<string>, model: string): boolean {
  return disabled.has(model) || disabled.has(model.replace(/^[^/]+\//, ""));
}
export function connectionLabel(meta: ConnectionMeta, providerId: string, accountId: string): string | undefined {
  return meta.providers[providerId]?.accounts?.[accountId]?.label;
}

export interface UsageWindow { kind: "credit-limit"; limit: number | null; remaining: number | null; usedTotal: number | null; usedDaily: number | null; usedWeekly: number | null; usedMonthly: number | null; currency: "USD"; resetsAt: null }
export type ConnectionUsage = { available: true; source: "openrouter-key"; window: UsageWindow; reason: null; fetchedAt: string } | { available: false; source: null; window: null; reason: string };
const unavailable = (reason: string): ConnectionUsage => ({ available: false, source: null, window: null, reason });
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Only what a provider genuinely exposes. OpenRouter documents `GET /api/v1/key` (limit, remaining, usage by
 * window). ChatGPT/Codex plan windows and Copilot quotas are only reachable through undocumented endpoints or
 * response headers the runtime does not capture, so they report `not_exposed` rather than an invented number.
 */
export async function fetchConnectionUsage(providerId: string, record: AccountRecord | undefined, fetchImpl: typeof fetch = fetch): Promise<ConnectionUsage> {
  if (providerId !== "openrouter") return unavailable("not_exposed");
  const secret = record?.kind === "api_key" ? record.secret : record?.tokens.accessToken;
  if (!secret) return unavailable("no_saved_key");
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) { await response.body?.cancel(); return unavailable(response.status === 401 || response.status === 403 ? "credentials_rejected" : "provider_error"); }
    const body = await response.json() as { data?: Record<string, unknown> };
    const data = body.data;
    if (!data || typeof data !== "object") return unavailable("provider_error");
    return { available: true, source: "openrouter-key", reason: null, fetchedAt: new Date().toISOString(),
      window: { kind: "credit-limit", limit: num(data.limit), remaining: num(data.limit_remaining), usedTotal: num(data.usage), usedDaily: num(data.usage_daily), usedWeekly: num(data.usage_weekly), usedMonthly: num(data.usage_monthly), currency: "USD", resetsAt: null } };
  } catch { return unavailable("provider_unreachable"); }
}

export interface ConnectionExtrasOptions { homeDir?: string; fetchImpl?: typeof fetch; knownProvider: (id: string) => boolean }
export class ConnectionExtras {
  readonly #options: ConnectionExtrasOptions;
  constructor(options: ConnectionExtrasOptions) { this.#options = options; }
  #parse(raw: string): { providerId: string; accountId: string } {
    let id: string;
    try { id = decodeURIComponent(raw); } catch { throw bad("Invalid connection id."); }
    const cut = id.indexOf(":");
    if (cut <= 0 || cut === id.length - 1) throw bad("Connection ids look like provider:account.");
    return { providerId: id.slice(0, cut), accountId: id.slice(cut + 1) };
  }
  #connection(store: AccountStore, meta: ConnectionMeta, providerId: string, accountId: string) {
    const entry = store.providers[providerId]; const record = entry?.accounts[accountId];
    if (!record) throw new ConnectionMetaError(404, "unknown_connection", "Saved connection does not exist.");
    const order = orderedAccountIds(store, meta, providerId);
    const defaultLabel = record.kind === "oauth" ? record.identity?.email ?? record.identity?.label ?? accountId : accountId;
    return { id: `${providerId}:${accountId}`, providerId, accountId, kind: record.kind, label: connectionLabel(meta, providerId, accountId) ?? defaultLabel, defaultLabel,
      active: entry!.activeAccountId === accountId, order: order.indexOf(accountId), disabledModels: meta.providers[providerId]?.accounts?.[accountId]?.disabledModels ?? [] };
  }
  #all() {
    const store = loadAccountStore(this.#options.homeDir); const meta = loadConnectionMeta(this.#options.homeDir);
    const connections = Object.keys(store.providers).filter(id => this.#options.knownProvider(id)).flatMap(providerId =>
      orderedAccountIds(store, meta, providerId).map(accountId => this.#connection(store, meta, providerId, accountId)));
    return { connections, spread: Object.fromEntries(Object.keys(store.providers).map(id => [id, meta.providers[id]?.spread === true])) };
  }
  #ensure(meta: ConnectionMeta, providerId: string): ProviderMeta { return meta.providers[providerId] ??= {}; }
  async #route(path: string, method: string, input: unknown): Promise<unknown> {
    const home = this.#options.homeDir;
    const body = () => { if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Expected a JSON object."); return input as Record<string, unknown>; };
    if (path === "connections" && method === "GET") return { ...this.#all(), orderSupport: { order: "display-and-spread-rotation", spread: "new-sessions", failover: false } };
    if (path === "connections/order" && method === "PUT") {
      const b = body(); const providerId = typeof b.providerId === "string" ? b.providerId : "";
      const store = loadAccountStore(home); const meta = loadConnectionMeta(home);
      const ids = Object.keys(store.providers[providerId]?.accounts ?? {});
      if (!ids.length) throw new ConnectionMetaError(404, "unknown_provider", "No saved accounts for that provider.");
      const wanted = b.accountIds;
      if (!Array.isArray(wanted) || wanted.length !== ids.length || new Set(wanted).size !== ids.length || wanted.some(id => typeof id !== "string" || !ids.includes(id))) throw bad("accountIds must list every saved account exactly once.", "invalid_order");
      this.#ensure(meta, providerId).order = wanted as string[]; saveConnectionMeta(meta, home);
      return this.#all();
    }
    if (path === "connections/spread" && method === "PUT") {
      const b = body(); const providerId = typeof b.providerId === "string" ? b.providerId : "";
      if (typeof b.enabled !== "boolean") throw bad("enabled must be a boolean.");
      const store = loadAccountStore(home); const meta = loadConnectionMeta(home);
      if (!store.providers[providerId]) throw new ConnectionMetaError(404, "unknown_provider", "No saved accounts for that provider.");
      const row = this.#ensure(meta, providerId); row.spread = b.enabled; delete row.cursor; saveConnectionMeta(meta, home);
      return this.#all();
    }
    const match = /^connections\/([^/]+?)(?:\/(models|usage))?$/.exec(path);
    if (!match) throw new ConnectionMetaError(405, "method_not_allowed", "Unsupported connection operation.");
    const { providerId, accountId } = this.#parse(match[1]!);
    const store = loadAccountStore(home); const meta = loadConnectionMeta(home);
    this.#connection(store, meta, providerId, accountId);
    if (match[2] === "usage" && method === "GET") return { usage: await fetchConnectionUsage(providerId, store.providers[providerId]!.accounts[accountId], this.#options.fetchImpl) };
    if (match[2] === "models" && method === "PUT") {
      const b = body();
      if (!Array.isArray(b.disabled) || b.disabled.length > 2048 || b.disabled.some(m => typeof m !== "string" || !m || m.length > 256 || /[\s\x00-\x1f\x7f]/.test(m))) throw bad("disabled must be a list of model ids.");
      const row = this.#ensure(meta, providerId); (row.accounts ??= {})[accountId] = { ...row.accounts[accountId], disabledModels: [...new Set(b.disabled as string[])] };
      saveConnectionMeta(meta, home);
      return { connection: this.#connection(store, loadConnectionMeta(home), providerId, accountId) };
    }
    if (!match[2] && method === "PATCH") {
      const b = body();
      if (b.label !== null && (typeof b.label !== "string" || !b.label.trim() || b.label.length > 80 || /[\x00-\x1f\x7f]/.test(b.label))) throw bad("label must be 1-80 characters or null.");
      const row = this.#ensure(meta, providerId); const accounts = (row.accounts ??= {}); const current = { ...accounts[accountId] };
      if (b.label === null) delete current.label; else current.label = (b.label as string).trim();
      accounts[accountId] = current; saveConnectionMeta(meta, home);
      const fresh = loadConnectionMeta(home);
      return { connection: this.#connection(store, fresh, providerId, accountId), ...this.#all() };
    }
    throw new ConnectionMetaError(405, "method_not_allowed", "Unsupported connection operation.");
  }
  async handle(path: string, method: string, input: unknown): Promise<{ status: number; data: unknown } | null> {
    if (!/^connections(?:\/|$)/.test(path) || (path === "connections" && method === "POST")) return null;
    try { return { status: 200, data: await this.#route(path, method, input) }; }
    catch (error) {
      if (error instanceof ConnectionMetaError) return { status: error.status, data: { code: error.code, error: error.message } };
      return { status: 500, data: { code: "operation_failed", error: "Connection preferences could not be read or saved." } };
    }
  }
}
