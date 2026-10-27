import { cn } from "../lib/utils.js";

/** Neutral usage meter; color follows the shared foreground rather than status colors. */
export function ContextRing({ percent, className }: { percent?: number; className?: string }) {
  const value = percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={cn("size-4 shrink-0 -rotate-90", className)} fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity=".2" />
    {value !== undefined && <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" pathLength="100" strokeDasharray={`${value} 100`} strokeLinecap="round" />}
  </svg>;
}
