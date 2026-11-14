import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import type { ConsoleSessionSnapshot, ConsoleWorker, DesktopConsoleDecisionResponse } from "@0/engine/shared";
import { Button } from "@/components/ui/button";
import { recoveredProviderError } from "./connection-recovery";
import { consoleErrorMessage, needsProviderSignIn, needsModelSourceReconnect } from "./provider-error";
import { Markdown } from "./markdown";
import { TurnTimeline } from "./turn-timeline";
import { InlineImage } from "./inline-image";
import { ApprovalPanel } from "./approvals";
import { ActivityRow } from "./activity-row";
import { ActivityIndicator } from "./loading-state";
import { AgentOnboarding } from "./agent-onboarding";
import { BrandMark } from "@/components/brand-mark";
import { WorkerTree, isCancellation } from "./worker-tree";
import { turnLimitNotice } from "./run-feedback";
import type { ReducedTurn } from "./transcript";
import type { ConsoleWorkspace } from "./use-console-workspace";

export type TranscriptWorkspace = Pick<ConsoleWorkspace, "busy" | "connectionRecovery" | "modelSourceRecovery" | "reconnectModelSource">;
// Stable identities exclude drafts while actions keep the latest page closures.
function useCurrentAction<T extends (...args: any[]) => any>(action: T): T {
  const latest = useRef(action);
  useLayoutEffect(() => { latest.current = action; }, [action]);
  return useCallback(((...args: Parameters<T>) => latest.current(...args)) as T, []);
}
export function useTranscriptControls(workspace: TranscriptWorkspace, onResolve: (id: string, response: DesktopConsoleDecisionResponse) => void, onSelectWorker: (id: string | null) => void) {
  const resolveDecision = useCurrentAction(onResolve);
  const selectWorker = useCurrentAction(onSelectWorker);
  const reconnectModelSource = useCurrentAction(() => workspace.reconnectModelSource?.() ?? Promise.resolve(false));
  const controls = useMemo<TranscriptWorkspace>(() => ({ busy: workspace.busy, connectionRecovery: workspace.connectionRecovery, modelSourceRecovery: workspace.modelSourceRecovery, reconnectModelSource: workspace.reconnectModelSource ? reconnectModelSource : undefined }), [workspace.busy, workspace.connectionRecovery?.providerId, workspace.connectionRecovery?.healthy, workspace.connectionRecovery?.checking, workspace.modelSourceRecovery?.healthy, workspace.modelSourceRecovery?.checking, Boolean(workspace.reconnectModelSource), reconnectModelSource]);
  return { workspace: controls, onResolve: resolveDecision, onSelectWorker: selectWorker };
}

export const TranscriptTurns = memo(function TranscriptTurns({ turns, turnWorkers, snapshot, canWrite, workspace, onResolve, onSelectWorker }: {
  turns: ReducedTurn[];
  turnWorkers: Map<string, ConsoleWorker[]>;
  snapshot: ConsoleSessionSnapshot;
  canWrite: boolean;
  workspace: TranscriptWorkspace;
  onResolve: (decisionId: string, response: DesktopConsoleDecisionResponse) => void;
  onSelectWorker: (id: string | null) => void;
}) {
  const active = ["working", "waiting", "cancelling"].includes(snapshot.session.status);
  return <>{turns.length ? turns.map((turn) => <article data-chat-turn={turn.id} id={`chat-${turn.id}`} key={turn.id} className="scroll-mt-6 space-y-5">
            {(turn.user.text || turn.user.attachments?.length) && <div className="ml-auto min-w-0 max-w-[92%] console-message-surface console-user-message px-4 py-3 text-sm break-words [&_p]:whitespace-pre-wrap">{turn.user.author && <p className="mb-1 text-xs text-muted-foreground">{turn.user.author.displayName}</p>}<Markdown text={turn.user.text} />{turn.user.attachments?.filter(item => item.kind === "image").map((item, index) => <InlineImage key={index} src={item.value} alt={item.name || "Attached image"} />)}</div>}
            <TurnTimeline turn={turn} streaming={turn.isWorking && snapshot.session.status === "working"} />
            {turn.decisions.filter((decision) => decision.resolved).map((decision) => <ActivityRow key={decision.id} icon={<ShieldCheck />} title={`${decision.title} · ${decision.approved === undefined ? "closed" : decision.approved ? decision.kind === "operator-question" ? "answered" : "approved" : "declined"}`} status=""><ApprovalPanel decision={decision} busy={workspace.busy || !canWrite} onResolve={(response) => onResolve(decision.id, response)} /></ActivityRow>)}
            <WorkerTree sessionId={snapshot.session.id} workers={turnWorkers.get(turn.id) ?? []} onSelect={onSelectWorker} />
            {turn.notices.filter(notice => !notice.startsWith("Cancellation requested.") && !notice.startsWith("Turn cancelled by operator") && !(turnLimitNotice(turn) && (notice.startsWith("Reached the ") && notice.includes("runaway cap") || notice.startsWith("Token budget for this turn is spent")))).map((notice, index) => <p key={index} className="border-l-2 border-border pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{notice}</p>)}
            {turnLimitNotice(turn) && <p role="status" className="border-l-2 border-border pl-3 text-xs text-muted-foreground">{turnLimitNotice(turn)}</p>}
            {(turn.stopReason === "cancelled" || turn.error?.startsWith("Workbench cancelled")) && <p role="status" className="text-xs text-muted-foreground">Stopped</p>}
            {turn.error && !turn.error.startsWith("Workbench cancelled") && !isCancellation(turn.error) && !recoveredProviderError(turn.error, workspace.connectionRecovery) && !(needsModelSourceReconnect(turn.error) && workspace.modelSourceRecovery?.healthy) && <div role="alert" className="rounded-[var(--radius-panel)] border border-destructive/30 bg-destructive/5 p-3 text-sm whitespace-pre-wrap text-destructive">{consoleErrorMessage(turn.error)}{needsModelSourceReconnect(turn.error) && workspace.reconnectModelSource && <Button type="button" variant="default" size="sm" className="mt-3 flex w-fit" disabled={!canWrite || workspace.busy || workspace.modelSourceRecovery?.checking || active} onClick={() => void workspace.reconnectModelSource?.()}>{workspace.modelSourceRecovery?.checking ? "Reconnecting…" : "Reconnect model source"}</Button>}{needsProviderSignIn(turn.error) && <Button asChild variant="default" size="sm" className="mt-3 flex w-fit"><Link to={`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`}>Manage connection</Link></Button>}</div>}
            {turn.isWorking && (turn.notices.some(notice => notice.startsWith("Cancellation requested.")) || snapshot.session.status === "waiting") && <ActivityIndicator waiting={snapshot.session.status === "waiting"} label={turn.notices.some(notice => notice.startsWith("Cancellation requested.")) ? "Stopping…" : snapshot.session.status === "waiting" ? "Waiting for your decision" : turn.toolCalls.some((call) => call.isRunning) ? "Running tools…" : turn.assistantText ? "Responding…" : "Thinking…"} />}
          </article>) : <div className="py-4 text-center"><div className="mb-8 flex justify-center"><AgentOnboarding /></div><BrandMark className="mb-7" /><h2 className="font-heading text-xl">What would you like to hack and fix today?</h2></div>}</>;
});
