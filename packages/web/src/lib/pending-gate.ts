import { useLayoutEffect, useRef, useState } from "react";

/** Nothing is drawn for the first 250 ms of a wait (SkeletonPanel fades in after the same delay). */
export const SKELETON_DELAY_MS = 250;
/** Once a skeleton has been drawn it stays at least this long, so a fetch finishing just after it appears cannot flash it. */
export const SKELETON_MIN_MS = 500;

/** How much longer a wait that lasted `pendingMs` must keep its skeleton on screen. */
export function skeletonHoldMs(pendingMs: number, delay = SKELETON_DELAY_MS, min = SKELETON_MIN_MS): number {
  if (pendingMs <= delay) return 0; // the skeleton never became visible
  return Math.max(0, delay + min - pendingMs);
}

/**
 * The one pending rule for page skeletons: `const loading = usePendingGate(query.isPending)`. Returns true while
 * pending and, if the skeleton had already become visible, until it has been visible for its minimum time.
 */
export function usePendingGate(pending: boolean): boolean {
  const startedAt = useRef<number | null>(null);
  const [holding, setHolding] = useState(false);
  useLayoutEffect(() => {
    if (pending) { startedAt.current ??= performance.now(); return; }
    if (startedAt.current === null) return;
    const hold = skeletonHoldMs(performance.now() - startedAt.current);
    startedAt.current = null;
    if (hold <= 0) return;
    setHolding(true);
    const id = window.setTimeout(() => setHolding(false), hold);
    return () => window.clearTimeout(id);
  }, [pending]);
  return pending || holding;
}
