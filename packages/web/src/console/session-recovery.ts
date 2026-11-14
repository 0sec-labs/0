import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
export interface SessionAlias { savedId: string; messageCount?: number }
export function staleSessionRecovery(id: string, sessions: DesktopConsoleSession[], saved: ConsoleSavedSession[], aliases: Record<string, SessionAlias>): { kind: "live" | "saved" | "blank"; id: string; durableId: string } | undefined {
  if (sessions.some(session => session.id === id && session.status !== "closed")) return undefined;
  const durableId = aliases[id]?.savedId ?? id;
  const live = sessions.find(session => session.status !== "closed" && (session.savedId === durableId || session.id === durableId));
  if (live) return { kind: "live", id: live.id, durableId };
  if (saved.some(session => session.id === durableId)) return { kind: "saved", id: durableId, durableId };
  if (aliases[id]?.messageCount === 0) return { kind: "blank", id, durableId };
  return undefined;
}
/** Copy all worker/root composer keys before replacing a stale session route. */
export function remapSessionDrafts<T>(drafts: Record<string, T>, from: string, to: string): Record<string, T> {
  if (from === to) return drafts;
  const next = { ...drafts };
  for (const [key, value] of Object.entries(drafts)) if (key.startsWith(`${from}:`)) {
    const target = `${to}:${key.slice(from.length + 1)}`;
    if (next[target] === undefined || next[target] === "") next[target] = value;
  }
  return next;
}
export type SessionRecoveryPlan = NonNullable<ReturnType<typeof staleSessionRecovery>>;
/** The route a recovered mission lives at. Only the live id is addressable by the host, so the old URL is replaced (never pushed) and its alias stays so it keeps resolving. */
export function recoveredSessionPath(replacementId: string, search: string): string {
  return `/chats/${replacementId}${search ? `?${search}` : ""}`;
}
/** An id no live session, saved transcript or alias explains, after the host answered "not found": it goes Home, never into a new empty mission. */
export function isMissingSession(input: { sessionId: string | undefined; hasSnapshot: boolean; recovering: boolean; loading: boolean; sessionsLoaded: boolean; savedLoaded: boolean; error?: string; sessions: DesktopConsoleSession[]; saved: ConsoleSavedSession[]; aliases: Record<string, SessionAlias> }): boolean {
  const { sessionId } = input;
  return Boolean(sessionId && !input.hasSnapshot && !input.recovering && !input.loading && input.sessionsLoaded && input.savedLoaded
    && /not found/i.test(input.error ?? "") && !staleSessionRecovery(sessionId, input.sessions, input.saved, input.aliases));
}
