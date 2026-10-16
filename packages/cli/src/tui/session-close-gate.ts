export interface SessionCloseGate {
  readonly closed: boolean;
  readonly signal: AbortSignal;
  close(): boolean;
  wait(): Promise<void>;
}

/**
 * Coordinates a session UI closing before or after its owner starts waiting.
 * Multiple owners may wait; every waiter resolves exactly once on close.
 */
export function createSessionCloseGate(): SessionCloseGate {
  let closed = false;
  const controller = new AbortController();
  const resolvers = new Set<() => void>();

  return {
    get closed(): boolean {
      return closed;
    },
    signal: controller.signal,
    close(): boolean {
      if (closed) return false;
      closed = true;
      controller.abort(new Error("Scan session closed by operator."));
      for (const resolve of resolvers) resolve();
      resolvers.clear();
      return true;
    },
    wait(): Promise<void> {
      if (closed) return Promise.resolve();
      const deferred = Promise.withResolvers<void>();
      resolvers.add(deferred.resolve);
      return deferred.promise;
    },
  };
}
