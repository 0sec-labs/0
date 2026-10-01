import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/shared";

export type SessionRailRow =
  | { kind: "live"; key: string; session: DesktopConsoleSession; timestamp: number }
  | { kind: "saved"; key: string; session: ConsoleSavedSession; timestamp: number };

/** Opening a transcript changes its live handle, not its position in history. */
export function orderSessionRail(live: DesktopConsoleSession[], saved: ConsoleSavedSession[], history: ConsoleSavedSession[]): SessionRailRow[] {
  const stored = new Map(history.map(session => [session.id, session]));
  const rows: SessionRailRow[] = [
    ...live.map(session => {
      const key = session.savedId ?? session.id;
      return { kind: "live" as const, key, session, timestamp: stored.get(key)?.savedAt ?? Date.parse(session.createdAt) };
    }),
    ...saved.map(session => ({ kind: "saved" as const, key: session.id, session, timestamp: session.savedAt })),
  ];
  return rows.sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key));
}
