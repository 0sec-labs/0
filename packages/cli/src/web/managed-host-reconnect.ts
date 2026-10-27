import { loadManagedWorker } from "../worker-deploy.js";

interface Registry {
  list(): Array<{ id: string; status: string }>;
  handshake(id: string): Promise<{ backend: { status: string } }>;
}
/** Recover registered, managed hosts only. Repair runs in the caller's async child process. */
export function startManagedHostReconnect(options: {
  getRegistry: () => Registry;
  repair: (backendId: string, signal: AbortSignal) => Promise<unknown>;
  onRecovered?: (backendId: string) => void | Promise<void>;
  getMetadata?: typeof loadManagedWorker;
  now?: () => number;
}): () => void {
  const metadata = options.getMetadata ?? loadManagedWorker;
  const now = options.now ?? Date.now;
  const attempts = new Map<string, { count: number; next: number }>();
  const controller = new AbortController();
  let busy = false;
  const tick = async () => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      const registry = options.getRegistry();
      const hosts = registry.list().filter(host => host.id !== "local");
      for (const id of attempts.keys()) if (!hosts.some(host => host.id === id)) attempts.delete(id);
      for (const host of hosts) {
        if (controller.signal.aborted) break;
        try {
          if (metadata(host.id).autoReconnect === false || (attempts.get(host.id)?.next ?? 0) > now()) continue;
          const view = await registry.handshake(host.id).catch(() => null);
          if (view?.backend.status === "connected") { attempts.delete(host.id); continue; }
          // Recheck registration/stop preference after the async handshake.
          if (controller.signal.aborted || !registry.list().some(item => item.id === host.id) || metadata(host.id).autoReconnect === false) continue;
          try {
            await options.repair(host.id, controller.signal);
            if (!controller.signal.aborted) await options.onRecovered?.(host.id);
            attempts.delete(host.id);
          } catch {
            const count = (attempts.get(host.id)?.count ?? 0) + 1;
            attempts.set(host.id, { count, next: now() + [60_000, 120_000, 300_000][Math.min(count - 1, 2)]! });
          }
          break; // At most one repair per tick, even for several disconnected hosts.
        } catch { /* Missing/untrusted metadata does not authorize a repair. */ }
      }
    } catch { /* Registry shutdown or refresh is retried on the next tick. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  timer.unref?.();
  void tick();
  return () => { clearInterval(timer); controller.abort(); };
}
