import type { ConsoleSessionSnapshot, DesktopConsoleSession } from "@0/engine/shared";

/** The snapshot as it will read once `title` is saved: shown at once, rolled back if the save fails. */
export function snapshotWithTitle(snapshot: ConsoleSessionSnapshot, id: string, title: string): ConsoleSessionSnapshot {
  if (snapshot.session.id !== id) return snapshot;
  return { ...snapshot, title, session: { ...snapshot.session, title, titleSource: "user" } };
}

/** The shared session list with one row renamed; other rows keep their identity so unrelated rows do not re-render. */
export function sessionsWithTitle(list: DesktopConsoleSession[], id: string, title: string): DesktopConsoleSession[] {
  return list.map(item => item.id === id ? { ...item, title, titleSource: "user" } : item);
}
