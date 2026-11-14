/**
 * The one door to browser persistence. Every localStorage/sessionStorage key the web app owns is declared here
 * (exact names or prefixes), reads are safe (private mode, corrupt JSON, quota), and `clearAppStorage` is the single
 * place that wipes it all (sign-out, reset). The IndexedDB query cache (`query-persist.ts`) keeps its own schema;
 * only its key name and database name are registered here so the wipe covers it too.
 *
 * Key strings are the on-disk contract: existing users' drafts, aliases and layouts live under them.
 * Add a `version` to a key's name (`...:v2`) when its payload shape changes, and list the old name in `legacy`.
 */
export type StorageArea = "local" | "session";

/** Exact keys the app reads and writes through `usePersistentState` or directly. */
export const STORAGE_KEYS = {
  theme: "zero-web-theme",
  accent: "zero-web-accent",
  colorTheme: "zero-web-color-theme",
  fontSize: "zero-web-font-size",
  motion: "zero-web-motion",
  teamModeHint: "0-team-mode",
  routeAliases: "0-console-route-aliases",
  sessionAliases: "0-console-session-aliases",
  activeSession: "0-console-active-session",
  drafts: "0-console-drafts",
  attachmentDrafts: "0-console-attachment-drafts",
  editorChatSessions: "0-editor-chat-sessions",
  recentWorkspaces: "0-recent-workspaces",
  sidebarOpen: "0-sidebar-open",
  sidebarWidth: "0-sidebar-width",
  sidebarSort: "host-sidebar-sort",
  sidebarChatsCollapsed: "host-sidebar-chats-collapsed",
  findingsView: "0:findings:view",
  setupCardDismissed: "0-setup-card-dismissed",
  updateCardDismissed: "0-update-card-dismissed",
  paletteRecents: "0-palette-recents",
  notificationPrefs: "0-notification-prefs",
  profile: "0-profile",
} as const;
  /** sessionStorage: text queued for the composer (`lib/composer-prefill.ts`). */
  composerPrefill: "0-composer-prefill",

/** Key families (a stored key is one of these prefixes plus a scope). */
export const STORAGE_PREFIXES: ReadonlyArray<{ area: StorageArea; prefix: string }> = [
  { area: "local", prefix: "0-backend:" }, // usePersistentState: backend/account-scoped state, drafts and dock layouts
  { area: "local", prefix: "0-last-model:" },
  { area: "local", prefix: "0-console-dock-view:" }, // pre-scoping dock layouts, still read once as a migration source
  { area: "session", prefix: "0:model-catalog:v1:" },
];
  { area: "session", prefix: "0-composer-prefill" },
/** Pre-scoping per-resource editor session ids (`<kind>-editor:<id>`), still read once as a migration source. */
const LEGACY_PATTERNS: readonly RegExp[] = [/^[a-z]+-editor:/];
export const QUERY_CACHE = { database: "0-web-cache", keyPrefix: "0-query-cache:" } as const;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

/** Parse JSON without throwing. Empty input and corrupt data yield the fallback. */
export function parseJson<T>(raw: string | null | undefined, fallback: T, validate?: (value: unknown) => value is T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as unknown;
    return validate ? (validate(value) ? value : fallback) : value as T;
  } catch { return fallback; }
}

export interface StorageApi {
  readText(key: string, area?: StorageArea): string | null;
  /** False when storage is unavailable or full; callers keep their in-memory copy. */
  writeText(key: string, value: string, area?: StorageArea): boolean;
  readJson<T>(key: string, fallback: T, options?: { area?: StorageArea; validate?: (value: unknown) => value is T }): T;
  writeJson(key: string, value: unknown, area?: StorageArea): boolean;
  remove(key: string, area?: StorageArea): void;
  /** Read `key`; when absent, read `legacyKey` once and copy it to `key` (never deleting the old entry). */
  readJsonMigrating<T>(key: string, legacyKey: string | undefined, fallback: T): T;
  /** Remove every key the registry owns. Returns how many were removed. */
  clear(): number;
}

export function createStorage(resolve: (area: StorageArea) => KeyValueStore | undefined): StorageApi {
  const get = (key: string, area: StorageArea) => { try { return resolve(area)?.getItem(key) ?? null; } catch { return null; } };
  const set = (key: string, value: string, area: StorageArea) => {
    try { const store = resolve(area); if (!store) return false; store.setItem(key, value); return true; } catch { return false; }
  };
  const owned = (key: string, area: StorageArea) =>
    (Object.values(STORAGE_KEYS) as string[]).includes(key) && area === "local"
    || STORAGE_PREFIXES.some(entry => entry.area === area && key.startsWith(entry.prefix))
    || (area === "local" && LEGACY_PATTERNS.some(pattern => pattern.test(key)));
  return {
    readText: (key, area = "local") => get(key, area),
    writeText: (key, value, area = "local") => set(key, value, area),
    readJson: (key, fallback, options) => parseJson(get(key, options?.area ?? "local"), fallback, options?.validate),
    writeJson(key, value, area = "local") {
      let raw: string | undefined;
      try { raw = JSON.stringify(value); } catch { return false; }
      return raw === undefined ? false : set(key, raw, area);
    },
    remove(key, area = "local") { try { resolve(area)?.removeItem(key); } catch { /* unavailable storage has nothing to remove */ } },
    readJsonMigrating(key, legacyKey, fallback) {
      const own = get(key, "local");
      const raw = own ?? (legacyKey ? get(legacyKey, "local") : null);
      if (!raw) return fallback;
      try {
        const value = JSON.parse(raw) as typeof fallback;
        if (own === null) set(key, raw, "local"); // quota failure leaves the legacy copy readable
        return value;
      } catch { return fallback; }
    },
    clear() {
      let removed = 0;
      for (const area of ["local", "session"] as const) {
        let store: KeyValueStore | undefined;
        try { store = resolve(area); } catch { continue; }
        if (!store || typeof store.length !== "number" || !store.key) continue;
        const doomed: string[] = [];
        for (let index = 0; index < store.length; index++) { const key = store.key(index); if (key && owned(key, area)) doomed.push(key); }
        for (const key of doomed) { try { store.removeItem(key); removed++; } catch { /* keep going */ } }
      }
      return removed;
    },
  };
}

export const browserStore = (area: StorageArea): KeyValueStore | undefined => {
  try { return typeof window === "undefined" ? undefined : area === "local" ? window.localStorage : window.sessionStorage; } catch { return undefined; }
};

export const storage = createStorage(browserStore);

/** Wipe all app-owned browser state: localStorage, sessionStorage and the IndexedDB query cache. */
export async function clearAppStorage(): Promise<void> {
  storage.clear();
  try {
    if (typeof indexedDB === "undefined") return;
    await new Promise<void>(resolve => {
      const request = indexedDB.deleteDatabase(QUERY_CACHE.database);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  } catch { /* nothing to clear */ }
}
