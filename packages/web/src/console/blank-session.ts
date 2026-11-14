import type { ConsoleSessionSnapshot, DesktopConsoleSession } from "@0/engine/shared";

const BLANK_TITLE = /^(new mission|new chat|new conversation|new session)$/i;

/** A conversation is blank until its first message; reuse one instead of piling up empty entries. */
export function isBlankSession(
  item: DesktopConsoleSession,
  snapshot: ConsoleSessionSnapshot | null | undefined,
): boolean {
  const live = snapshot?.session.id === item.id ? snapshot : undefined;
  const session = live?.session ?? item;
  if (session.status !== "ready" || session.messageCount !== 0) return false;
  return (
    !live ||
    (live.messages.length === 0 &&
      live.queuedMessages.length === 0 &&
      !live.stagedPrompt &&
      !live.events.some((event) => event.type === "user"))
  );
}

export function findBlankSession(
  sessions: DesktopConsoleSession[],
  snapshot: ConsoleSessionSnapshot | null | undefined,
  teamEnabled: boolean,
): DesktopConsoleSession | undefined {
  if (teamEnabled) return undefined;
  return sessions.find(
    (item) => isBlankSession(item, snapshot) && !item.target && (!item.title || BLANK_TITLE.test(item.title)),
  );
}

/** Run `task` while holding a browser-wide lock so concurrent tabs cannot each create a blank chat. */
export function withCreateLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? (locks.request("0-create-blank-chat", task) as Promise<T>) : task();
}
