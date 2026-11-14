/**
 * Cross-instance read coalescing. The sidebar, workspace, rail and findings views each own their own query key
 * (and sometimes their own API instance) for the same endpoint, so identical GETs overlap. This joins an in-flight
 * request or reuses a result younger than `ttlMs`; any mutation (`bustSharedReads`) discards everything so
 * read-after-write is never stale. Callers keep their own abort semantics: aborting one never fails the others.
 */
interface Entry { at: number; promise: Promise<unknown> }
const reads = new Map<string, Entry>();

export function bustSharedReads(): void { reads.clear(); }

export async function sharedRead<T>(key: string, ttlMs: number, load: () => Promise<T>, signal?: AbortSignal, now: () => number = Date.now): Promise<T> {
  signal?.throwIfAborted();
  let entry = reads.get(key);
  if (!entry || now() - entry.at >= ttlMs) {
    const promise = load();
    const created: Entry = { at: now(), promise };
    entry = created;
    reads.set(key, created);
    // Failures are never reused, and a newer entry is never evicted by an older failure.
    promise.catch(() => { if (reads.get(key) === created) reads.delete(key); });
  }
  const shared = entry.promise as Promise<T>;
  if (!signal) return shared;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([shared, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
