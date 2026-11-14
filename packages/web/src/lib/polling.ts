import { useEffect, useRef } from "react";

/** True while the tab is in the foreground. Treated as visible when `document` is unavailable (tests, SSR). */
export function documentVisible(doc: Pick<Document, "visibilityState"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return doc ? doc.visibilityState !== "hidden" : true;
}

/**
 * Interval for a react-query `refetchInterval`: `activeMs` while work is in flight, `idleMs` (or `false` = no polling)
 * otherwise. Window focus and mount refetches keep idle data fresh, so idle polling is a slow safety net.
 */
export function pollInterval(active: boolean, activeMs: number, idleMs: number | false = false): number | false {
  return active ? activeMs : idleMs;
}

/**
 * setInterval that only ticks while the tab is visible and runs `callback` once when the tab becomes visible again after
 * at least `ms` hidden, so a backgrounded tab costs no requests but returns fresh. `ms === false` disables it.
 */
export function startVisibleInterval(callback: () => void, ms: number, doc: Document = document, win: Pick<Window, "setInterval" | "clearInterval"> = window, now: () => number = Date.now): () => void {
  let last = now();
  const run = () => { last = now(); callback(); };
  const timer = win.setInterval(() => { if (documentVisible(doc)) run(); }, ms);
  const onVisible = () => { if (documentVisible(doc) && now() - last >= ms) run(); };
  doc.addEventListener("visibilitychange", onVisible);
  return () => { win.clearInterval(timer); doc.removeEventListener("visibilitychange", onVisible); };
}

export function useVisibleInterval(callback: () => void, ms: number | false): void {
  const latest = useRef(callback);
  useEffect(() => { latest.current = callback; });
  useEffect(() => {
    if (ms === false) return;
    return startVisibleInterval(() => latest.current(), ms);
  }, [ms]);
}
