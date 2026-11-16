import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { v } from "@/lib/vocabulary";
import { Button } from "@/components/ui/button";

/**
 * The empty mission Home shows before the real one exists (bare /chats while the first mission is created, or its
 * snapshot is in flight). It is only ever rendered by Home's own layout, so the composer is the real one, in the real
 * place; its session-bound controls are disabled until the live snapshot replaces this one. `id` matches the key the
 * workspace stores drafts under (`new` before a mission exists), so typing is never lost when the id arrives.
 */
export function pendingHomeSnapshot(id: string): ConsoleSessionSnapshot {
  const now = new Date(0).toISOString();
  return {
    session: { id, target: "", role: "audit", autonomyMode: "changes", scopeConfigured: false, localScopeConfigured: false, status: "ready", createdAt: now, updatedAt: now, messageCount: 0 },
    title: "",
    cursor: 0,
    messages: [],
    events: [],
    pendingDecisions: [],
    workers: [],
    queuedMessages: [],
    runtime: null,
    scope: null,
    scopeEnforcement: { pluginId: "", enabled: false, projectPath: "", message: "" },
    usage: { inputTokens: 0, outputTokens: 0 },
    lastOutcome: null,
    compaction: null,
    objective: "",
    todos: null,
    tools: [],
  };
}

/** Inline failure for a pane that could not load: it explains, offers Retry, and never replaces the composer. */
export function ChatLoadError({ message, onRetry, className = "" }: { message: string; onRetry: () => void; className?: string }) {
  return <div role="alert" data-chat-load-error className={`flex max-w-md items-center gap-3 rounded-[var(--radius-card,8px)] bg-card px-4 py-3 text-[13px] text-foreground shadow-[var(--shadow-composer)] ${className}`}>
    <span className="min-w-0 flex-1">{message}</span>
    <Button type="button" size="sm" variant="outline" onClick={onRetry}>{v("Retry")}</Button>
  </div>;
}
