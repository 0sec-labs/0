import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ConsoleCreateSessionInput, ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
import type { NavigateFunction } from "react-router-dom";
import { rememberSessionAlias, staleSessionRecovery, type SessionAlias } from "./session-recovery";

type Aliases = Record<string, SessionAlias>;
interface RecoveryWorkspace {
  sessionsLoaded: boolean;
  savedLoaded: boolean;
  sessions: DesktopConsoleSession[];
  saved: ConsoleSavedSession[];
  perform: <T>(action: () => Promise<T>, sessionId?: string) => Promise<T | undefined>;
  remapDrafts: (from: string, to: string) => void;
  dismissError: () => void;
}

/**
 * A URL or stored id the host no longer serves is replaced by its live/saved/blank successor.
 * The address bar keeps the opened id; recovery is recorded as an alias. Returns whether a recovery is running.
 */
export function useStaleSessionRecovery(input: {
  embedded: boolean;
  sessionId: string | undefined;
  routeSessionId: string | undefined;
  backendId: string;
  readOnlyTeam: boolean;
  workspace: RecoveryWorkspace;
  sessionAliases: Aliases;
  setSessionAliases: Dispatch<SetStateAction<Aliases>>;
  navigate: NavigateFunction;
  search: URLSearchParams;
  resumeConsoleSession: (id: string, options: Record<string, never>) => Promise<DesktopConsoleSession>;
  createOwnedSession: (configuration: ConsoleCreateSessionInput) => Promise<DesktopConsoleSession | undefined>;
  onDockSessionResolved?: (backendId: string, oldId: string, session: DesktopConsoleSession) => void;
}): boolean {
  const {
    embedded,
    sessionId,
    routeSessionId,
    backendId,
    readOnlyTeam,
    workspace,
    sessionAliases,
    setSessionAliases,
    navigate,
    search,
    resumeConsoleSession,
    createOwnedSession,
    onDockSessionResolved,
  } = input;
  const recoveryAttempt = useRef<string | null>(null);
  const [recoveringSession, setRecoveringSession] = useState(false);
  useEffect(() => {
    if (!sessionId || !workspace.sessionsLoaded || !workspace.savedLoaded) return;
    const plan = staleSessionRecovery(sessionId, workspace.sessions, workspace.saved, sessionAliases);
    if (!plan) return;
    const key = `${backendId}:${sessionId}`;
    if (recoveryAttempt.current === key) return;
    recoveryAttempt.current = key;
    const recover = async () => {
      setRecoveringSession(true);
      try {
        let replacement =
          plan.kind === "live" ? workspace.sessions.find((session) => session.id === plan.id) : undefined;
        if (!replacement && plan.kind === "saved") {
          if (readOnlyTeam) {
            if (!embedded) navigate(`/chats/saved/${plan.id}`, { replace: true });
            return;
          }
          replacement = await workspace.perform(() => resumeConsoleSession(plan.id, {}), sessionId);
        }
        if (!replacement && plan.kind === "blank" && !readOnlyTeam) replacement = await createOwnedSession({});
        if (!replacement) return;
        workspace.remapDrafts(sessionId, replacement.id);
        setSessionAliases((previous) => ({
          ...previous,
          [sessionId]: { savedId: plan.durableId, messageCount: replacement!.messageCount },
          [replacement!.id]: {
            savedId: replacement!.savedId ?? plan.durableId,
            messageCount: replacement!.messageCount,
          },
        }));
        workspace.dismissError();
        if (embedded) onDockSessionResolved?.(backendId, sessionId, replacement);
        else if (routeSessionId) rememberSessionAlias(routeSessionId, replacement.id);
      } finally {
        setRecoveringSession(false);
      }
    };
    void recover();
  }, [
    embedded,
    sessionId,
    workspace.sessionsLoaded,
    workspace.savedLoaded,
    workspace.sessions,
    workspace.saved,
    sessionAliases,
    backendId,
    readOnlyTeam,
    navigate,
    resumeConsoleSession,
    search,
  ]);
  return recoveringSession;
}
