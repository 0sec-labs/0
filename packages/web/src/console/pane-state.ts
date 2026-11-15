import { useEffect, useState } from "react";

/** What the chat pane shows. Only `skeleton` is a placeholder, and only for a mission that is opening. */
export type ChatPaneState = "blank" | "home" | "skeleton" | "failed" | "conversation";

/** Home (no mission yet) never waits behind a transcript placeholder; its error banner appears after this long. */
export const HOME_LOAD_TIMEOUT_MS = 8_000;
/** An opening mission that has not arrived by now gets an explanation and a Retry instead of an endless skeleton. */
export const MISSION_LOAD_TIMEOUT_MS = 12_000;

export interface ChatPaneInput {
  hasSnapshot: boolean;
  /** The route names a mission (or a mission is bound) but its snapshot has not arrived. */
  loading: boolean;
  recovering: boolean;
  hasSession: boolean;
  /** The Home landing: bare /chats, or the blank mission it just opened. */
  homeLanding: boolean;
  /** The route names a mission no roster, saved transcript or alias knows (rosters settled): it resolves to Home once, so show Home meanwhile. */
  unknownRoute?: boolean;
  /** A non-transient failure for this pane (snapshot error, failed creation). */
  failed: boolean;
  timedOut: boolean;
  /** Embedded, saved-transcript and read-only team views keep their own layouts. */
  ownLayout: boolean;
}

/**
 * Branch selection for the chat pane, in priority order: a loaded mission always wins; Home renders its real composer
 * at once; a mission that is still opening shows the thread skeleton; a failed or overdue load shows Retry, never a
 * skeleton that can stick.
 */
export function chatPaneState(input: ChatPaneInput): ChatPaneState {
  if (input.hasSnapshot) return "conversation";
  if ((input.homeLanding || input.unknownRoute) && !input.ownLayout) return "home";
  if (input.failed || input.timedOut) return "failed";
  if (!input.hasSession && !input.loading && !input.recovering) return "blank";
  return "skeleton";
}

/** Becomes true once `active` has held for `ms` without interruption; resets as soon as it clears. */
export function useLoadTimeout(active: boolean, ms: number, attempt = 0): boolean {
  const [reached, setReached] = useState(false);
  useEffect(() => {
    setReached(false);
    if (!active) return;
    const timer = setTimeout(() => setReached(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms, attempt]);
  return active && reached;
}
