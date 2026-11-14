import type { DesktopConsoleSession } from "@0/engine/shared";

/** The live session already resuming/resumed from this saved record, newest first. Repeated opens must reuse it. */
export function findLiveForSaved(sessions: readonly DesktopConsoleSession[] | undefined, savedId: string): DesktopConsoleSession | undefined {
  const time = (session: DesktopConsoleSession) => Date.parse(session.updatedAt) || Date.parse(session.createdAt) || 0;
  return (sessions ?? []).filter(session => session.status !== "closed" && (session.savedId === savedId || session.id === savedId)).sort((left, right) => time(right) - time(left))[0];
}

const inflight = new Map<string, Promise<DesktopConsoleSession>>();
/**
 * Resume a saved mission at most once: reuse a live session from the roster, else join the in-flight resume, else start one.
 * Browsing a saved transcript never calls this; only composer focus or send does.
 */
export function resumeSavedOnce({ backendId, savedId, roster, resume }: { backendId: string; savedId: string; roster?: readonly DesktopConsoleSession[]; resume: () => Promise<DesktopConsoleSession> }): Promise<DesktopConsoleSession> {
  const live = findLiveForSaved(roster, savedId);
  if (live) return Promise.resolve(live);
  const key = `${backendId}\0${savedId}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const started = resume().finally(() => { if (inflight.get(key) === started) inflight.delete(key); });
  inflight.set(key, started);
  return started;
}
