import { useSyncExternalStore } from "react";
import { getSettings, subscribeSettings } from "./settings-store.js";
import type { TuiSettings } from "./settings.js";

/**
 * React hook: subscribe to the store and re-render exactly when settings
 * change, never otherwise. A thin `useSyncExternalStore` — it does not tear
 * (the store hands back a stable reference between changes) and it unsubscribes
 * on unmount via the subscribe function's returned disposer.
 */
export function useSettings(): TuiSettings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}
