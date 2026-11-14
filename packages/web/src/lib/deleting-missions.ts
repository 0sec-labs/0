/** Missions being deleted right now. Their closing must not trigger the stale-session recovery that resumes saved work. */
const deleting = new Map<string, number>();
const HOLD_MS = 15_000;

export function markMissionsDeleting(...ids: Array<string | undefined>): void {
  const until = Date.now() + HOLD_MS;
  for (const id of ids) if (id) deleting.set(id, until);
}

export function isMissionDeleting(...ids: Array<string | undefined>): boolean {
  const now = Date.now();
  return ids.some((id) => {
    if (!id) return false;
    const until = deleting.get(id);
    if (until === undefined) return false;
    if (until < now) { deleting.delete(id); return false; }
    return true;
  });
}

export function clearMissionsDeleting(...ids: Array<string | undefined>): void {
  for (const id of ids) if (id) deleting.delete(id);
}
