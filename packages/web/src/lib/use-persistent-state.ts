import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { backendStorageKey } from "./backend-client";
import { storage } from "./storage";

type Entry = { value: unknown; listeners: Set<() => void>; onStorage?: (event: StorageEvent) => void };
const entries = new Map<string, Entry>();
const unobservedSnapshot = () => null;
function readStoredValue<T>(key: string, fallback: T, legacyLocalKey?: string): T {
  return storage.readJsonMigrating(key, legacyLocalKey, fallback);
}
function entryFor<T>(key: string, fallback: T, legacy?: string, persist = true): Entry {
  let entry = entries.get(key);
  if (!entry) { entry = { value: persist ? readStoredValue(key, fallback, legacy) : fallback, listeners: new Set() }; entries.set(key, entry); }
  return entry;
}

/** One store per scoped key keeps drafts coherent across simultaneous docked chats. */
export function usePersistentState<T>(key: string, fallback: T, options?: { persist?: boolean; legacyKey?: string; observe?: boolean }) {
  const persist = options?.persist !== false;
  const observe = options?.observe !== false;
  const { client } = useBackendApi();
  const team = useTeamAccess();
  const account = team.enabled && team.user ? JSON.stringify([team.user.workspaceId, team.user.userId]) : undefined;
  const legacy = options?.legacyKey
    ? backendStorageKey(client.backendId, account ? `account:${account}:${options.legacyKey}` : options.legacyKey)
    : client.backendId === "local" && !account ? key : undefined;
  const scoped = backendStorageKey(client.backendId, account ? `account:${account}:${key}` : key);
  const entry = persist ? entryFor(scoped, fallback, legacy) : entryFor(`memory:${scoped}`, fallback, undefined, false);
  const subscribe = useCallback((listener: () => void) => {
    if (!observe) return () => {};
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
  }, [entry, scoped, persist, observe]);
  const getSnapshot = useCallback(() => entry.value as T, [entry]);
  // Event handlers can read the current value without subscribing a whole page
  // to every keystroke. Input controls remain subscribed to the same store.
  const observed = useSyncExternalStore(subscribe, observe ? getSnapshot : unobservedSnapshot, observe ? getSnapshot : unobservedSnapshot);
  const value = observe ? observed as T : entry.value as T;
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    const next = typeof update === "function" ? (update as (previous:T)=>T)(entry.value as T) : update;
    if (Object.is(next, entry.value)) return;
    entry.value = next;
    // Restricted or full storage still keeps in-memory drafts usable.
    if (persist) storage.writeJson(scoped, next);
    for (const notify of entry.listeners) notify();
  }, [entry, scoped, persist]);
  return [value, setValue, getSnapshot] as const;
}
