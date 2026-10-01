import { useEffect, useState } from "react";
import { useBackendApi } from "@/api";
import { backendStorageKey } from "./backend-client";

function readStoredValue<T>(key: string, fallback: T, legacyLocalKey?: string): T {
  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(key) ?? (legacyLocalKey ? window.localStorage.getItem(legacyLocalKey) : null);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function usePersistentState<T>(key: string, fallback: T) {
  const { client } = useBackendApi();
  const legacyLocalKey = client.backendId === "local" ? key : undefined;
  key = backendStorageKey(client.backendId, key);
  const [value, setValue] = useState<T>(() => readStoredValue(key, fallback, legacyLocalKey));

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage failures in private browsing or restricted environments.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
