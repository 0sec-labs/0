import { useSyncExternalStore } from "react";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
import { STORAGE_KEYS, storage } from "@/lib/storage";
export interface SessionAlias {
  savedId: string;
  messageCount?: number;
}
export function staleSessionRecovery(
  id: string,
  sessions: DesktopConsoleSession[],
  saved: ConsoleSavedSession[],
  aliases: Record<string, SessionAlias>,
): { kind: "live" | "saved" | "blank"; id: string; durableId: string } | undefined {
  if (sessions.some((session) => session.id === id && session.status !== "closed")) return undefined;
  const durableId = aliases[id]?.savedId ?? id;
  const live = sessions.find(
    (session) => session.status !== "closed" && (session.savedId === durableId || session.id === durableId),
  );
  if (live) return { kind: "live", id: live.id, durableId };
  if (saved.some((session) => session.id === durableId)) return { kind: "saved", id: durableId, durableId };
  if (aliases[id]?.messageCount === 0) return { kind: "blank", id, durableId };
  return undefined;
}
/** Copy all worker/root composer keys before replacing a stale session route. */
export function remapSessionDrafts<T>(drafts: Record<string, T>, from: string, to: string): Record<string, T> {
  if (from === to) return drafts;
  const next = { ...drafts };
  for (const [key, value] of Object.entries(drafts))
    if (key.startsWith(`${from}:`)) {
      const target = `${to}:${key.slice(from.length + 1)}`;
      if (next[target] === undefined || next[target] === "") next[target] = value;
    }
  return next;
}
/** The route a recovered mission lives at when the caller has to leave the old URL (read-only teams, tests). Normal recovery keeps the URL and records an alias instead. */
export function recoveredSessionPath(replacementId: string, search: string): string {
  return `/chats/${replacementId}${search ? `?${search}` : ""}`;
}

const ALIAS_KEY = STORAGE_KEYS.routeAliases;
const aliasListeners = new Set<() => void>();
let aliasCache: { raw: string | null; value: Record<string, string> } | undefined;
let memoryOnly: Record<string, string> | undefined;
function storedAliases(): string | null {
  return storage.readText(ALIAS_KEY);
}
function readAliasMap(): Record<string, string> {
  const raw = storedAliases();
  if (memoryOnly && raw === null) return memoryOnly;
  if (aliasCache?.raw === raw) return aliasCache.value;
  let value: Record<string, string> = {};
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (parsed && typeof parsed === "object") value = parsed as Record<string, string>;
  } catch {
    /* corrupt map starts over */
  }
  aliasCache = { raw, value };
  return value;
}
/** Follow URL id -> live id links (loop-safe). With no map argument the persisted one is used. */
export function resolveSessionAlias(id: string, map?: Record<string, string>): string;
export function resolveSessionAlias(id: string | undefined, map?: Record<string, string>): string | undefined;
export function resolveSessionAlias(
  id: string | undefined,
  map: Record<string, string> = readAliasMap(),
): string | undefined {
  if (!id) return id;
  let current = id;
  const seen = new Set([id]);
  while (map[current] && !seen.has(map[current]!)) {
    current = map[current]!;
    seen.add(current);
  }
  return current;
}
/** The address-bar id keeps working after its live session is replaced: remember where it now lives. */
export function rememberSessionAlias(from: string, to: string): void {
  if (from === to) return;
  const next = { ...readAliasMap(), [from]: to };
  delete next[to];
  const entries = Object.entries(next).slice(-200);
  const value = Object.fromEntries(entries);
  const raw = JSON.stringify(value);
  storage.writeText(ALIAS_KEY, raw); // when full, the in-memory cache below still serves this tab
  aliasCache = { raw: storedAliases() ?? null, value };
  if (aliasCache.raw !== raw) memoryOnly = value;
  aliasListeners.forEach((listener) => listener());
}
const subscribeAliases = (listener: () => void) => {
  aliasListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    aliasListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};
/** Reactive `resolveSessionAlias` for components that read the id from the URL. */
export function useResolvedSessionId(id: string | undefined): string | undefined {
  const map = useSyncExternalStore(subscribeAliases, readAliasMap, () => ({}));
  return resolveSessionAlias(id, map);
}
/** An id no live session, saved transcript or alias explains, after the host answered "not found": it goes Home, never into a new empty mission. */
export function isMissingSession(input: {
  sessionId: string | undefined;
  hasSnapshot: boolean;
  recovering: boolean;
  loading: boolean;
  sessionsLoaded: boolean;
  savedLoaded: boolean;
  error?: string;
  sessions: DesktopConsoleSession[];
  saved: ConsoleSavedSession[];
  aliases: Record<string, SessionAlias>;
}): boolean {
  const { sessionId } = input;
  return Boolean(
    sessionId &&
    !input.hasSnapshot &&
    !input.recovering &&
    !input.loading &&
    input.sessionsLoaded &&
    input.savedLoaded &&
    /not found/i.test(input.error ?? "") &&
    !staleSessionRecovery(sessionId, input.sessions, input.saved, input.aliases),
  );
}
