import { useEffect, useRef, useState } from "react";
import { WifiOff } from "lucide-react";
import { localControlFetch } from "@/api";
import { isTransientMessage } from "@/lib/network-resilience";
import { Button } from "@/ui/components/button";

/** Seconds between automatic checks: 2, 4, 8, 16, then every 30. */
const BACKOFF_MS = [2000, 4000, 8000, 16_000, 30_000] as const;

/**
 * Shown in the app frame when the computer cannot be reached. It checks again on its own with backoff and hands
 * control back through `onReachable` as soon as the connection service answers; the button forces a check now.
 */
export function ConnectionLost({ backendId, message, onReachable }: { backendId: string; message?: string; onReachable: () => void }) {
  const [checking, setChecking] = useState(false);
  const reachable = useRef(onReachable);
  reachable.current = onReachable;
  const check = useRef<() => Promise<boolean>>(async () => false);
  check.current = async () => {
    setChecking(true);
    try {
      const response = await localControlFetch(`/api/backends/${encodeURIComponent(backendId)}/handshake`, { signal: AbortSignal.timeout(8000) });
      return response.ok && Boolean(response.headers.get("content-type")?.includes("json"));
    } catch { return false; } finally { setChecking(false); }
  };
  const detail = message && !isTransientMessage(message) ? message : "";
  useEffect(() => {
    // A definite refusal (not registered, incompatible) will not fix itself; only the button retries it.
    if (detail) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (attempt: number) => {
      timer = setTimeout(async () => {
        if (!live) return;
        if (await check.current()) { if (live) reachable.current(); return; }
        if (live) schedule(attempt + 1);
      }, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    };
    schedule(0);
    return () => { live = false; clearTimeout(timer); };
  }, [backendId, detail]);
  return <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background" data-connection-lost>
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <WifiOff aria-hidden="true" className="size-6 text-muted-foreground-2" />
      <div role="status" className="space-y-1">
        <p className="text-sm font-medium text-foreground">Can't reach this computer</p>
        <p className="text-sm text-muted-foreground">{detail ? "" : checking ? "Checking…" : "Trying again automatically"}</p>
        {detail && <p className="max-w-sm text-xs text-muted-foreground-1">{detail}</p>}
      </div>
      <Button variant="outline" size="sm" onClick={() => { if (detail) { onReachable(); return; } void check.current().then(ok => { if (ok) reachable.current(); }); }}>Reconnect</Button>
    </main>
  </div>;
}
