import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

/** Work shorter than this never flashes a shimmer: the label stays plain text until the wait is real. */
export const SHIMMER_DELAY_MS = 250;
const SWEEP_MS = 2000;

/** Negative delay on the shared document clock, so a shimmer handed from one row to the next stays in phase. */
function clockDelay(): CSSProperties | undefined {
  if (typeof document === "undefined") return undefined;
  const now = document.timeline?.currentTime;
  return typeof now === "number" ? { animationDelay: `-${Math.round(now % SWEEP_MS)}ms` } : undefined;
}

/**
 * The single in-progress cue. Callers decide which one element is active; this renders plain text for everything
 * else, and for an active element only after SHIMMER_DELAY_MS. Reduced motion is handled by `.ui-text-shimmer`.
 */
export function ShimmerText({ active, className, children }: { active: boolean; className?: string; children: ReactNode }) {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!active) { setLit(false); return; }
    const timer = setTimeout(() => setLit(true), SHIMMER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active]);
  const shimmer = active && lit;
  return <span data-shimmer-active={active || undefined} data-shimmer={shimmer || undefined} className={[className, shimmer ? "ui-text-shimmer" : ""].filter(Boolean).join(" ") || undefined} style={shimmer ? clockDelay() : undefined}>{children}</span>;
}
