import { QUERY_CACHE } from "./storage";
import { dehydrate, hydrate, type DehydratedState, type Query, type QueryClient } from "@tanstack/react-query";

/**
 * Stale-while-revalidate persistence for the engine-scoped React Query cache.
 *
 * Only list-shaped, non-sensitive-by-key data is stored (sessions, saved sessions, sidebar history slices and
 * the most recent mission snapshots). Errors, auth/team state and everything else are never written. The payload
 * is keyed per backend id, stamped with a buster (app version + schema), size-capped and written on a throttle.
 * This is the same dehydrate/hydrate contract as `@tanstack/react-query-persist-client` without a new dependency.
 */
export const PERSIST_SCHEMA = 1;
export const MAX_PERSISTED_SNAPSHOTS = 5;
export const MAX_PERSISTED_BYTES = 3 * 1024 * 1024;
export const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;
export const PERSIST_THROTTLE_MS = 5000;
/** Hydrated queries must outlive the session or the next write would silently drop them. */
export const HYDRATED_GC_MS = 24 * 60 * 60 * 1000;

export interface PersistedCache { schema: number; buster: string; timestamp: number; state: DehydratedState }
type Key = readonly unknown[];

export function persistBuster(version: string): string { return `${version}:${PERSIST_SCHEMA}`; }
export function persistStorageKey(backendId: string): string { return `${QUERY_CACHE.keyPrefix}${backendId}`; }

export function isSnapshotKey(key: Key): boolean { return key[0] === "console-snapshot"; }
/** Allow-list by query key. Anything not listed (team session, settings, handshakes, health checks) stays in memory. */
export function isPersistableKey(key: Key): boolean {
  return key[0] === "console-sessions" || key[0] === "console-saved" || key[0] === "host-sidebar-chats" || isSnapshotKey(key);
}

export function shouldDehydrateQuery(query: Pick<Query, "queryKey" | "state">): boolean {
  return query.state.status === "success" && query.state.data !== undefined && isPersistableKey(query.queryKey);
}

/** Keep the N most recently updated snapshots; list queries are always kept. */
export function limitSnapshots(state: DehydratedState, max = MAX_PERSISTED_SNAPSHOTS): DehydratedState {
  const snapshots = state.queries.filter(query => isSnapshotKey(query.queryKey)).sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt).slice(0, max);
  const keep = new Set(snapshots);
  return { ...state, queries: state.queries.filter(query => !isSnapshotKey(query.queryKey) || keep.has(query)) };
}

/** Worker transcripts dominate snapshot size. A trimmed snapshot is marked expired so the next mount refetches it in full. */
function stripWorkerTranscripts(state: DehydratedState): DehydratedState {
  return { ...state, queries: state.queries.map(query => {
    const data = query.state.data as { workers?: Array<Record<string, unknown>> } | undefined;
    if (!isSnapshotKey(query.queryKey) || !Array.isArray(data?.workers) || !data.workers.some(worker => Array.isArray(worker.transcript) && worker.transcript.length > 0)) return query;
    return { ...query, state: { ...query.state, dataUpdatedAt: 0, data: { ...data, workers: data.workers.map(worker => ({ ...worker, transcript: [], operatorMessages: [] })) } } };
  }) };
}

/** Serialize within the byte cap: trim worker transcripts, then drop the oldest snapshots, then all snapshots. */
export function serializeCache(state: DehydratedState, options: { buster: string; now?: number; maxBytes?: number; maxSnapshots?: number }): string | null {
  const maxBytes = options.maxBytes ?? MAX_PERSISTED_BYTES;
  const encode = (value: DehydratedState) => JSON.stringify({ schema: PERSIST_SCHEMA, buster: options.buster, timestamp: options.now ?? Date.now(), state: value } satisfies PersistedCache);
  const fits = (text: string) => text.length <= maxBytes;
  let current = limitSnapshots({ mutations: [], queries: state.queries }, options.maxSnapshots);
  let text = encode(current);
  if (fits(text)) return text;
  current = stripWorkerTranscripts(current);
  text = encode(current);
  if (fits(text)) return text;
  const ordered = current.queries.filter(query => isSnapshotKey(query.queryKey)).sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt || 0);
  for (let keep = ordered.length - 1; keep >= 0; keep--) {
    current = limitSnapshots(current, keep);
    text = encode(current);
    if (fits(text)) return text;
  }
  return null;
}

/** Validate a stored payload: shape, schema, buster and age. Anything else is discarded. */
export function parseCache(raw: unknown, options: { buster: string; now?: number; maxAgeMs?: number }): DehydratedState | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedCache> | null;
    if (!value || value.schema !== PERSIST_SCHEMA || value.buster !== options.buster || typeof value.timestamp !== "number") return null;
    if ((options.now ?? Date.now()) - value.timestamp > (options.maxAgeMs ?? MAX_PERSISTED_AGE_MS)) return null;
    if (!value.state || !Array.isArray(value.state.queries)) return null;
    const queries = value.state.queries.filter(query => query && Array.isArray(query.queryKey) && isPersistableKey(query.queryKey) && query.state?.status === "success" && query.state.data !== undefined);
    return { mutations: [], queries };
  } catch { return null; }
}

export interface AsyncStore { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }

/** A 30-line IndexedDB key/value store. Any failure (private mode, quota) degrades to "no persistence". */
export function indexedDbStore(name: string = QUERY_CACHE.database): AsyncStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = undefined; reject(request.error); };
  });
  const run = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const request = action(db.transaction("kv", mode).objectStore("kv"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    get: key => run<unknown>("readonly", store => store.get(key)).then(value => typeof value === "string" ? value : undefined),
    set: async (key, value) => { await run("readwrite", store => store.put(value, key)); },
    remove: async key => { await run("readwrite", store => store.delete(key)); },
  };
}

export interface QueryPersistence { restored: Promise<void>; flush(): void; clear(): void; dispose(): void }

/** Hydrate `client` from storage, then mirror persistable queries back on a throttle and on page hide. */
export function attachQueryPersistence(client: QueryClient, options: { backendId: string; version: string; enabled?: boolean; store?: AsyncStore | null; throttleMs?: number }): QueryPersistence {
  const store = options.enabled === false ? null : options.store === undefined ? indexedDbStore() : options.store;
  const key = persistStorageKey(options.backendId);
  const buster = persistBuster(options.version);
  if (!store) {
    // Disabled (for example team mode): never keep an earlier local-mode copy around either.
    if (options.enabled === false) void indexedDbStore()?.remove(key).catch(() => {});
    return { restored: Promise.resolve(), flush() {}, clear() {}, dispose() {} };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let writing = false;
  const write = () => {
    timer = undefined;
    if (disposed || writing) return;
    writing = true;
    try {
      const text = serializeCache(dehydrate(client, { shouldDehydrateQuery, shouldRedactErrors: () => true }), { buster });
      void (text ? store.set(key, text) : store.remove(key)).catch(() => {}).finally(() => { writing = false; });
    } catch { writing = false; }
  };
  const schedule = () => { if (!timer && !disposed) timer = setTimeout(write, options.throttleMs ?? PERSIST_THROTTLE_MS); };
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type === "updated" || event.type === "removed") { if (isPersistableKey(event.query.queryKey)) schedule(); }
  });
  const flush = () => { if (timer) { clearTimeout(timer); write(); } };
  const onHide = () => { if (document.visibilityState === "hidden") flush(); };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", flush);
  const restored = store.get(key).then(raw => {
    const state = parseCache(raw, { buster });
    if (!state) { if (raw !== undefined) void store.remove(key).catch(() => {}); return; }
    if (!disposed) hydrate(client, state, { defaultOptions: { queries: { gcTime: HYDRATED_GC_MS } } });
  }).catch(() => {});
  return {
    restored,
    flush,
    clear() { if (timer) clearTimeout(timer); timer = undefined; void store.remove(key).catch(() => {}); },
    dispose() {
      flush();
      disposed = true; unsubscribe();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    },
  };
}
