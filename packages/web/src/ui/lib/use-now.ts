import { useEffect, useState } from "react";

/**
 * Current time in epoch milliseconds, refreshed every `intervalMs` while `active`.
 * When inactive the value is re-sampled once and no timer runs, so idle surfaces stay observer-free.
 */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
