import { useEffect } from "react";
import type { DesktopConsoleSession } from "@0/engine/shared";
import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import type { SessionAlias } from "./session-recovery";

type SessionAliases = Record<string, SessionAlias>;

/** Merge the roster into the alias map; returns the same object when nothing changed. */
export function mergeSessionAliases(previous: SessionAliases, sessions: DesktopConsoleSession[]): SessionAliases {
  const next = { ...previous };
  let changed = false;
  for (const session of sessions) {
    const alias = { savedId: session.savedId ?? session.id, messageCount: session.messageCount };
    if (next[session.id]?.savedId !== alias.savedId || next[session.id]?.messageCount !== alias.messageCount) {
      next[session.id] = alias;
      changed = true;
    }
  }
  return changed ? next : previous;
}

/** Persisted live-id -> durable-id aliases, refreshed whenever the live roster loads. */
export function useSessionAliases(roster: { sessionsLoaded: boolean; sessions: DesktopConsoleSession[] }) {
  const [sessionAliases, setSessionAliases] = usePersistentState<SessionAliases>(STORAGE_KEYS.sessionAliases, {});
  useEffect(() => {
    if (!roster.sessionsLoaded) return;
    setSessionAliases((previous) => mergeSessionAliases(previous, roster.sessions));
  }, [roster.sessionsLoaded, roster.sessions, setSessionAliases]);
  return [sessionAliases, setSessionAliases] as const;
}
