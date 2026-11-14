// Short-TTL read-through cache with in-flight coalescing for hot polled GET endpoints.
//
// Several browser pollers hit the same endpoint within a few seconds. Concurrent
// identical requests share one computation, and the result is reused for a short
// window. Any mutating API request calls `invalidateReadCache()` so an operator
// action is never answered with a pre-action snapshot from this process.

const DEFAULT_TTL_MS = 1_000;
const entries = new Map<string, { at: number; epoch: number; value: Promise<unknown> }>();
let epoch = 0;

export function invalidateReadCache(): void {
  epoch += 1;
  entries.clear();
}

export function readThrough<T>(key: string, compute: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.epoch === epoch && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = compute();
  entries.set(key, { at: Date.now(), epoch, value });
  // Never cache a failure.
  value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
  return value;
}
