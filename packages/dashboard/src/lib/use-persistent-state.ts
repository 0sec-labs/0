import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { backendStorageKey } from "./backend-client";

type Entry = { value: unknown; listeners: Set<() => void>; onStorage?: (event: StorageEvent) => void };
const entries = new Map<string, Entry>();
function readStoredValue<T>(key: string, fallback: T, legacyLocalKey?: string): T {
  if (typeof window === "undefined") return fallback;
  try {
    const own = window.localStorage.getItem(key);
    const raw = own ?? (legacyLocalKey ? window.localStorage.getItem(legacyLocalKey) : null);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as T;
    if (own === null && legacyLocalKey) {
      try { window.localStorage.setItem(key, raw); } catch { /* Legacy state remains usable when storage is full. */ }
    }
    return value;
  } catch { return fallback; }
}
function entryFor<T>(key: string, fallback: T, legacy?: string, persist = true): Entry {
  let entry = entries.get(key);
  if (!entry) { entry = { value: persist ? readStoredValue(key, fallback, legacy) : fallback, listeners: new Set() }; entries.set(key, entry); }
  return entry;
}

/** One store per scoped key keeps drafts coherent across simultaneous docked chats. */
export function usePersistentState<T>(key: string, fallback: T, options?: { persist?: boolean; legacyKey?: string }) {
  const persist = options?.persist !== false;
  const { client } = useBackendApi();
  const team = useTeamAccess();
  const account = team.enabled && team.user ? JSON.stringify([team.user.workspaceId, team.user.userId]) : undefined;
  const legacy = options?.legacyKey
    ? backendStorageKey(client.backendId, account ? `account:${account}:${options.legacyKey}` : options.legacyKey)
    : client.backendId === "local" && !account ? key : undefined;
  const scoped = backendStorageKey(client.backendId, account ? `account:${account}:${key}` : key);
  const entry = persist ? entryFor(scoped, fallback, legacy) : entryFor(`memory:${scoped}`, fallback, undefined, false);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    if (!persist) return () => { entry.listeners.delete(listener); };
    if (!entry.onStorage) {
      entry.onStorage = event => {
        if (event.key !== scoped) return;
        entry.value = readStoredValue(scoped, fallback, legacy);
        for (const notify of entry.listeners) notify();
      };
      window.addEventListener("storage", entry.onStorage);
    }
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.onStorage) { window.removeEventListener("storage", entry.onStorage); entry.onStorage = undefined; }
    };
  }, [entry, scoped, persist]);
  const getSnapshot = useCallback(() => entry.value as T, [entry]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    const next = typeof update === "function" ? (update as (previous:T)=>T)(entry.value as T) : update;
    if (Object.is(next, entry.value)) return;
    entry.value = next;
    try { if (persist) window.localStorage.setItem(scoped, JSON.stringify(next)); } catch { /* Restricted storage still keeps in-memory drafts usable. */ }
    for (const notify of entry.listeners) notify();
  }, [entry, scoped, persist]);
  return [value, setValue] as const;
}
