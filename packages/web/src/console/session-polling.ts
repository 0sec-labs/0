import type { DesktopConsoleSession } from "@0/engine/shared";
import { pollInterval } from "@/lib/polling";

/** Active lists poll briskly; an idle list is a slow safety net because focus/mount refetches and the event feed keep it fresh. */
export const SESSIONS_POLL_MS = 10_000;
export const SESSIONS_IDLE_POLL_MS = 60_000;
export const SAVED_POLL_MS = 120_000;

export function sessionsActive(sessions: readonly DesktopConsoleSession[] | undefined): boolean {
  return sessions?.some(session => session.status === "working" || session.status === "waiting" || session.status === "cancelling") ?? true;
}

/** `refetchInterval` for the shared `["console-sessions"]` query, used by every observer of that key. */
export const sessionsRefetchInterval = (query: { state: { data: readonly DesktopConsoleSession[] | undefined } }) => pollInterval(sessionsActive(query.state.data), SESSIONS_POLL_MS, SESSIONS_IDLE_POLL_MS);
