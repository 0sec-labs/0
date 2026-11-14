import type { ConsoleSavedSession, ConsoleSessionSnapshot, DesktopConsoleSession } from "@0/engine/shared";
import type { ConsoleMessagesPage, WindowedSnapshot } from "./snapshot-window";
import { findLiveForSaved } from "@/lib/lazy-resume";

/** Newest messages shown when a saved mission opens; older ones load on request. */
export const SAVED_OPEN_WINDOW = 60;

/**
 * A retained transcript, shaped like a resumed session's snapshot so the one live Conversation renders it.
 * It is idle, has no journal, workers, approvals or grants, and carries the windowing meta that "Load earlier messages" needs.
 * Reading it never starts an engine; the first send resumes the mission.
 */
export function savedTranscriptSnapshot(savedId: string, page: ConsoleMessagesPage & { meta: ConsoleSavedSession }): WindowedSnapshot {
  const { meta } = page;
  const savedAt = new Date(Number.isFinite(meta.savedAt) ? meta.savedAt : 0).toISOString();
  const title = (meta.summary || meta.preview || "").trim() || "Saved mission";
  const session: DesktopConsoleSession = {
    id: savedId,
    savedId,
    target: meta.target ?? "",
    role: "discovery",
    autonomyMode: "standard",
    scopeConfigured: false,
    localScopeConfigured: false,
    status: "ready",
    createdAt: savedAt,
    updatedAt: savedAt,
    title,
    messageCount: page.total,
  };
  const snapshot: ConsoleSessionSnapshot = {
    session,
    title,
    cursor: 0,
    messages: page.messages,
    events: [],
    pendingDecisions: [],
    workers: [],
    queuedMessages: [],
    runtime: null,
    scope: null,
    scopeEnforcement: { pluginId: "", enabled: false, projectPath: meta.cwd ?? "", message: "" },
    usage: { inputTokens: 0, outputTokens: 0 },
    lastOutcome: null,
    compaction: null,
    harness: null,
    objective: "",
    todos: null,
    tools: [],
  };
  return {
    ...snapshot,
    window: {
      messages: page.messages.length,
      messagesTotal: page.total,
      firstMessageIndex: page.messages.length ? page.firstIndex : null,
      events: 0,
      eventsTotal: 0,
      workers: "full",
    },
  };
}

/** `/chats/saved/:id` opens the live session that already owns the record; otherwise the retained transcript. */
export function savedRouteTarget(
  savedId: string | undefined,
  roster: readonly DesktopConsoleSession[] | undefined,
): { kind: "live"; sessionId: string } | { kind: "saved"; savedId: string } | undefined {
  if (!savedId) return undefined;
  const live = findLiveForSaved(roster, savedId);
  return live ? { kind: "live", sessionId: live.id } : { kind: "saved", savedId };
}
