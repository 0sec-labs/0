import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import type { ConsoleMessageInput, ConsoleSessionSnapshot, ConsoleWorker, DesktopConsoleDecisionResponse } from "@0/engine/shared";
import { Button } from "@/components/ui/button";
import { recoveredProviderError } from "./connection-recovery";
import { consoleErrorMessage, needsProviderSignIn, needsModelSourceReconnect } from "./provider-error";
import { Markdown } from "./markdown";
import { TurnTimeline } from "./turn-timeline";
import { InlineImage } from "./inline-image";
import { ApprovalPanel } from "./approvals";
import { DayStamp, MessageToolbar, dayKey } from "./message-toolbar";
import { ActivityIndicator } from "./loading-state";
import { AgentOnboarding } from "./agent-onboarding";
import { BrandMark } from "@/components/brand-mark";
import { WorkerTree, isCancellation } from "./worker-tree";
import { RefreshCw, RotateCcw } from "lucide-react";
import { isRetryableError, messageLink } from "./transcript-actions";
import { Disclosure } from "@/components/ui/disclosure";
import { SYNTHETIC_PROMPT_LABELS, classifySyntheticPrompt } from "./synthetic-prompt";
import { turnLimitNotice } from "./run-feedback";
import type { ReducedTurn } from "./transcript";
import { isLifecycleNotice, visibleResolvedDecisions } from "./transcript-visibility";
import type { ConsoleWorkspace } from "./use-console-workspace";

export type TranscriptWorkspace = Pick<
  ConsoleWorkspace,
  "busy" | "connectionRecovery" | "modelSourceRecovery" | "reconnectModelSource"
>;
// Stable identities exclude drafts while actions keep the latest page closures.
function useCurrentAction<T extends (...args: any[]) => any>(action: T): T {
  const latest = useRef(action);
  useLayoutEffect(() => {
    latest.current = action;
  }, [action]);
  return useCallback(((...args: Parameters<T>) => latest.current(...args)) as T, []);
}
export function useTranscriptControls(
  workspace: TranscriptWorkspace,
  onResolve: (id: string, response: DesktopConsoleDecisionResponse) => void,
  onSelectWorker: (id: string | null) => void,
) {
  const resolveDecision = useCurrentAction(onResolve);
  const selectWorker = useCurrentAction(onSelectWorker);
  const reconnectModelSource = useCurrentAction(() => workspace.reconnectModelSource?.() ?? Promise.resolve(false));
  const controls = useMemo<TranscriptWorkspace>(
    () => ({
      busy: workspace.busy,
      connectionRecovery: workspace.connectionRecovery,
      modelSourceRecovery: workspace.modelSourceRecovery,
      reconnectModelSource: workspace.reconnectModelSource ? reconnectModelSource : undefined,
    }),
    [
      workspace.busy,
      workspace.connectionRecovery?.providerId,
      workspace.connectionRecovery?.healthy,
      workspace.connectionRecovery?.checking,
      workspace.modelSourceRecovery?.healthy,
      workspace.modelSourceRecovery?.checking,
      Boolean(workspace.reconnectModelSource),
      reconnectModelSource,
    ],
  );
  return { workspace: controls, onResolve: resolveDecision, onSelectWorker: selectWorker };
}

export const TranscriptTurns = memo(function TranscriptTurns({
  turns,
  turnWorkers,
  snapshot,
  canWrite,
  workspace,
  onResolve,
  onSelectWorker,
  onReference,
  onRetry,
}: {
  turns: ReducedTurn[];
  turnWorkers: Map<string, ConsoleWorker[]>;
  snapshot: ConsoleSessionSnapshot;
  canWrite: boolean;
  workspace: TranscriptWorkspace;
  onResolve: (decisionId: string, response: DesktopConsoleDecisionResponse) => void;
  onSelectWorker: (id: string | null) => void;
  /** Adds a visual reference to the composer draft. */
  onReference?: (text: string) => void;
  /** Re-sends a user message through the composer's send path (the latest turn's generic errors only). */
  onRetry?: (message: { text: string; attachments?: ConsoleMessageInput["attachments"] }) => void;
}) {
  const active = ["working", "waiting", "cancelling"].includes(snapshot.session.status);
  const href = typeof window === "undefined" ? undefined : window.location.href;
  // A pasted message link scrolls to its turn once the transcript has rendered.
  const firstTurn = turns[0]?.id;
  useEffect(() => {
    const target = window.location.hash.startsWith("#chat-") ? window.location.hash.slice(1) : undefined;
    if (target) document.getElementById(target)?.scrollIntoView({ block: "start" });
  }, [firstTurn, snapshot.session.id]);
  return (
    <>
      {turns.length ? (
        turns.map((turn, turnIndex) => {
          const stamp =
            dayKey(turn.startedAt) !== undefined && dayKey(turn.startedAt) !== dayKey(turns[turnIndex - 1]?.startedAt);
          const synthetic = turn.user.attachments?.length ? undefined : classifySyntheticPrompt(turn.user.text);
          return (
            <article
              data-chat-turn={turn.id}
              id={`chat-${turn.id}`}
              key={turn.id}
              className={`scroll-mt-6 mb-0! flex min-w-0 flex-col gap-3 in-data-[density=compact]:gap-2 ${stamp ? "mt-6" : "mt-8"} first:mt-0 in-data-[density=compact]:not-first:mt-5`}
            >
              {stamp && <DayStamp iso={turn.startedAt} />}
              {synthetic && (
                <Disclosure
                  className="mx-auto w-full max-w-[77%] min-w-0"
                  data-slot="synthetic-prompt"
                  triggerClassName="mx-auto flex min-h-7 w-fit max-w-full items-center gap-1.5 rounded-[var(--radius-inner,4px)] text-xs text-muted-foreground-2 transition-colors hover:text-muted-foreground-1"
                  contentClassName="pt-1"
                  summary={
                    <>
                      <RefreshCw aria-hidden="true" className="size-3 flex-none" />
                      <span className="truncate">{SYNTHETIC_PROMPT_LABELS[synthetic]}</span>
                    </>
                  }
                >
                  <div className="rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card px-3 py-2 text-xs whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                    {turn.user.text}
                  </div>
                </Disclosure>
              )}
              {!synthetic && (turn.user.text || turn.user.attachments?.length) && (
                <div data-slot="user-message" className="flex min-w-0 flex-col items-end">
                  <div className="group/rail relative flex min-w-0 max-w-[77%] flex-col items-end in-data-[show-timestamps=true]:mt-6">
                    <MessageToolbar
                      iso={turn.startedAt}
                      text={turn.user.text}
                      onReply={canWrite ? onReference : undefined}
                      link={href ? messageLink(href, turn.id) : undefined}
                    />
                    <div className="min-w-0 max-w-full rounded-[var(--radius-card,8px)] bg-secondary px-3 py-2 text-sm text-foreground wrap-anywhere">
                      {turn.user.author && (
                        <p className="mb-1 text-xs text-muted-foreground">{turn.user.author.displayName}</p>
                      )}
                      <Markdown text={turn.user.text} />
                      {turn.user.attachments
                        ?.filter((item) => item.kind === "image")
                        .map((item, index) => (
                          <InlineImage key={index} src={item.value} alt={item.name || "Attached image"} />
                        ))}
                    </div>
                  </div>
                </div>
              )}
              <TurnTimeline
                turn={turn}
                streaming={turn.isWorking && snapshot.session.status === "working"}
                onReference={canWrite ? onReference : undefined}
                latestTurn={turnIndex === turns.length - 1}
                sessionId={snapshot.session.id}
                subagents={turnWorkers.get(turn.id)?.length ?? 0}
              />
              {visibleResolvedDecisions(turn).map((decision) => (
                <ApprovalPanel
                  key={decision.id}
                  decision={decision}
                  busy={workspace.busy || !canWrite}
                  onResolve={(response) => onResolve(decision.id, response)}
                />
              ))}
              <div className="contents in-data-[show-subagents=false]:hidden">
                <WorkerTree
                  sessionId={snapshot.session.id}
                  workers={turnWorkers.get(turn.id) ?? []}
                  onSelect={onSelectWorker}
                />
              </div>
              {turn.notices
                .filter(
                  (notice) =>
                    !isLifecycleNotice(notice) &&
                    !notice.startsWith("Cancellation requested.") &&
                    !notice.startsWith("Turn cancelled by operator") &&
                    !(
                      turnLimitNotice(turn) &&
                      ((notice.startsWith("Reached the ") && notice.includes("runaway cap")) ||
                        notice.startsWith("Token budget for this turn is spent"))
                    ),
                )
                .map((notice, index) => (
                  <p key={index} className="rounded-md px-2 text-xs whitespace-pre-wrap text-muted-foreground">
                    {notice}
                  </p>
                ))}
              {turnLimitNotice(turn) && (
                <p role="status" className="rounded-md px-2 text-xs text-muted-foreground">
                  {turnLimitNotice(turn)}
                </p>
              )}
              {(turn.stopReason === "cancelled" || turn.error?.startsWith("Workbench cancelled")) && (
                <p role="status" className="w-fit rounded-md bg-secondary/60 px-2 py-1 text-xs text-muted-foreground">
                  Stopped
                </p>
              )}
              {turn.error &&
                !turn.error.startsWith("Workbench cancelled") &&
                !isCancellation(turn.error) &&
                !recoveredProviderError(turn.error, workspace.connectionRecovery) &&
                !(needsModelSourceReconnect(turn.error) && workspace.modelSourceRecovery?.healthy) && (
                  <div
                    role="alert"
                    className="rounded-md border-[0.5px] border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-destructive wrap-anywhere"
                  >
                    {consoleErrorMessage(turn.error)}
                    {needsModelSourceReconnect(turn.error) && workspace.reconnectModelSource && (
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        className="mt-3 flex w-fit"
                        disabled={!canWrite || workspace.busy || workspace.modelSourceRecovery?.checking || active}
                        onClick={() => void workspace.reconnectModelSource?.()}
                      >
                        {workspace.modelSourceRecovery?.checking ? "Reconnecting…" : "Reconnect model source"}
                      </Button>
                    )}
                    {onRetry &&
                      turnIndex === turns.length - 1 &&
                      !active &&
                      canWrite &&
                      !turn.isWorking &&
                      !synthetic &&
                      isRetryableError(turn.error) &&
                      (turn.user.text || turn.user.attachments?.length) && (
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          className="mt-3 flex w-fit gap-1.5"
                          disabled={workspace.busy}
                          onClick={() => onRetry({ text: turn.user.text, attachments: turn.user.attachments })}
                        >
                          <RotateCcw aria-hidden="true" className="size-3.5" />
                          Retry
                        </Button>
                      )}
                    {needsProviderSignIn(turn.error) && (
                      <Button
                        variant="default"
                        size="sm"
                        className="mt-3 flex w-fit"
                        render={
                          <Link
                            to={`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/chats/${snapshot.session.id}`)}`}
                          />
                        }
                      >
                        Manage connection
                      </Button>
                    )}
                  </div>
                )}
              {turn.isWorking &&
                (turn.notices.some((notice) => notice.startsWith("Cancellation requested.")) ||
                  (snapshot.session.status === "waiting" && !snapshot.pendingDecisions.length)) && (
                  <ActivityIndicator
                    mark={false}
                    waiting={snapshot.session.status === "waiting"}
                    label={
                      turn.notices.some((notice) => notice.startsWith("Cancellation requested."))
                        ? "Stopping…"
                        : snapshot.session.status === "waiting"
                          ? "Waiting"
                          : turn.toolCalls.some((call) => call.isRunning)
                            ? "Running tools…"
                            : turn.assistantText
                              ? "Responding…"
                              : "Thinking…"
                    }
                  />
                )}
            </article>
          );
        })
      ) : (
        <div className="py-4 text-center">
          <div className="mb-8 flex justify-center">
            <AgentOnboarding />
          </div>
          <BrandMark className="mb-7" />
          <h2 className="font-heading text-xl">What would you like to hack and fix today?</h2>
        </div>
      )}
    </>
  );
});
