import { useEffect, useRef } from "react";

/**
 * Lets one activation through until the action it started settles, so a double click cannot send two requests
 * before `pending` has rendered. Returns false for a repeated activation (and cancels its default).
 */
export function useSubmitGuard(pending: boolean | undefined): (event?: { preventDefault: () => void }) => boolean {
  const locked = useRef(false);
  const seenPending = useRef(false);
  useEffect(() => {
    if (pending) seenPending.current = true;
    else if (seenPending.current) { seenPending.current = false; locked.current = false; }
  }, [pending]);
  return event => {
    if (locked.current) { event?.preventDefault(); return false; }
    locked.current = true;
    // An action that never reports pending (or settles before it renders) releases after a short grace period.
    setTimeout(() => { if (!seenPending.current) locked.current = false; }, 600);
    return true;
  };
}
